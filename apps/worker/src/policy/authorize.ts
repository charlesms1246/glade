import { mandateCheck, mandateHash, type ActiveMandate, type CheckResult, type MandateTerms } from "@glade/engine";
import { dec, planChallenge, planHash } from "@glade/shared";
import { verifyAuthenticationResponse, type AuthenticationResponseJSON } from "@simplewebauthn/server";
import { z } from "zod";

const decStr = z.string().regex(/^\d+(\.\d+)?$/);

const legSchema = z.object({
  assetId: z.string(),
  side: z.enum(["buy", "sell"]),
  qty: decStr,
  reduceOnly: z.boolean(),
  notionalUsd: decStr,
  beta: decStr,
  leverage: z.union([z.string(), z.number()]).nullish(),
  qtyUnit: z.enum(["base", "quote"]).optional(),
});
const planSchema = z.object({ assetIds: z.array(z.string()).min(1), legs: z.array(legSchema).min(1) }).passthrough();

const inputsSchema = z.object({
  source: z.enum(["user", "automation"]),
  notionalUsd: decStr,
  planHash: z.string().optional(),
  plan: z.unknown().optional(),
  assertion: z.unknown().optional(),
  credentialId: z.string().optional(),
  beta: decStr.optional(),
});

export interface IntentRow {
  id: string;
  userId: string;
  kind: "open" | "increase" | "decrease" | "close" | "spot_buy" | "spot_sell";
  assetId: string;
  side: "buy" | "sell";
  qty: string;
  qtyUnit: "base" | "quote";
  leverage: string | null;
  reduceOnly: boolean;
  planHash: string | null;
  inputs: unknown;
}

export interface StoredPasskey {
  credentialId: string;
  publicKey: Uint8Array;
  transports?: string[] | null;
}

/** An active mandate as stored, with what is needed to prove the user signed exactly these terms. */
export interface SignedMandate extends ActiveMandate {
  id: string;
  terms: MandateTerms;
  storedHash: string;
  approval: unknown;
}

export interface PolicyDeps {
  /** Execution environment. Production is always refused by the engine. */
  env: "paper" | "uat" | "prod";
  maxOrderUsd: string;
  /** Leverage cap for user-approved plans without a mandate. */
  userLeverageCap: string;
  origin: string | string[];
  rpID: string | string[];
  getPasskey: (userId: string, credentialId: string) => Promise<StoredPasskey | null>;
  getActiveMandate: (userId: string) => Promise<SignedMandate | null>;
  /** `${mandateId}:${hash}` pairs already proven authentic in this process. */
  verifiedMandates?: Set<string>;
  tradesToday: (userId: string, now: Date) => Promise<number>;
  riskyValue: (userId: string) => Promise<string>;
  /** Size of the automation-owned (Floor) short on a perp; lets a reduce-only close run without an active mandate. */
  ownedShortQty?: (userId: string, perpAssetId: string) => Promise<string>;
  /** Holding value of this perp's symbol group and the short already open on it. Falls back to `riskyValue`. */
  exposure?: (userId: string, perpAssetId: string) => Promise<{ holdingValue: string; existingShortUsd: string }>;
  /** Product type of an asset from the registry; null when unknown. */
  assetType: (assetId: string) => Promise<"spot" | "perp" | null>;
  /** Other live (pending, executing or done) intents of this plan that match the same leg. */
  liveSiblings: (row: IntentRow) => Promise<number>;
  verify?: typeof verifyAuthenticationResponse;
}

const deny = (...reasons: string[]): CheckResult => ({ ok: false, reasons });

/** The signing policy for one stored intent. Nothing is stamped unless this returns ok. */
export async function authorizeIntent(row: IntentRow, deps: PolicyDeps, now: Date): Promise<CheckResult> {
  const parsed = inputsSchema.safeParse(row.inputs);
  if (!parsed.success) return deny("intent inputs are malformed");
  const inp = parsed.data;
  const spotKind = row.kind === "spot_buy" || row.kind === "spot_sell";
  const type = await deps.assetType(row.assetId);
  if (!type) return deny("unknown asset");
  if ((type === "spot") !== spotKind) return deny("intent kind does not match the asset type");
  const spot = type === "spot";

  let assertion: { planHash: string; approvedAssetIds: string[] } | null = null;
  let beta = inp.beta ?? "1";

  if (inp.source === "user") {
    const plan = planSchema.safeParse(inp.plan);
    if (!plan.success) return deny("approved plan is malformed");
    const hash = planHash(inp.plan);
    if (hash !== row.planHash || hash !== inp.planHash) return deny("plan hash does not match the approved plan");

    const sameLev = (l: z.infer<typeof legSchema>) =>
      l.leverage == null ? row.leverage === null : row.leverage !== null && dec(l.leverage).eq(dec(row.leverage));
    const matches = plan.data.legs.filter(
      (l) =>
        l.assetId === row.assetId &&
        l.side === row.side &&
        l.reduceOnly === row.reduceOnly &&
        (l.qtyUnit ?? "base") === row.qtyUnit &&
        sameLev(l) &&
        dec(l.qty).eq(dec(row.qty)),
    );
    const leg = matches[0];
    if (!leg) return deny("intent is not a leg of the approved plan");
    // One approval covers each leg once: a replayed or duplicated intent for the same leg is refused.
    if ((await deps.liveSiblings(row)) >= matches.length) return deny("this approved leg was already used");
    if (!dec(leg.notionalUsd).eq(dec(inp.notionalUsd))) return deny("intent notional differs from the approved plan");
    beta = leg.beta;

    if (!inp.credentialId || !inp.assertion) return deny("missing passkey approval");
    const pk = await deps.getPasskey(row.userId, inp.credentialId);
    if (!pk) return deny("passkey not registered to this user");
    try {
      const v = await (deps.verify ?? verifyAuthenticationResponse)({
        response: inp.assertion as AuthenticationResponseJSON,
        expectedChallenge: planChallenge(hash),
        expectedOrigin: deps.origin,
        expectedRPID: deps.rpID,
        requireUserVerification: true,
        // The web app already advanced the stored counter for this assertion; this check is about
        // authenticity and binding to the plan, and each intent executes at most once.
        credential: { id: pk.credentialId, publicKey: new Uint8Array(pk.publicKey), counter: 0 },
      });
      if (!v.verified) return deny("passkey approval did not verify");
    } catch (e) {
      return deny(`passkey approval did not verify: ${String(e).slice(0, 120)}`);
    }
    assertion = { planHash: hash, approvedAssetIds: plan.data.assetIds };
  }

  const [signed, tradesToday, riskyValue, exposure] = await Promise.all([
    inp.source === "automation" ? deps.getActiveMandate(row.userId) : Promise.resolve(null),
    deps.tradesToday(row.userId, now),
    deps.riskyValue(row.userId),
    !spot && deps.exposure ? deps.exposure(row.userId, row.assetId) : Promise.resolve(null),
  ]);

  let mandate: ActiveMandate | null = signed;
  if (signed && !(await mandateIsAuthentic(signed, row.userId, deps))) mandate = null;
  const windDown = inp.source === "automation" && !mandate && !spot && row.side === "buy" && row.reduceOnly && row.qtyUnit === "base";
  const ownedShortQty = windDown && deps.ownedShortQty ? await deps.ownedShortQty(row.userId, row.assetId) : undefined;

  return mandateCheck(
    {
      kind: row.kind,
      side: row.side,
      assetId: row.assetId,
      instrument: spot ? "spot" : "perp",
      reduceOnly: row.reduceOnly,
      leverage: row.leverage,
      notionalUsd: inp.notionalUsd,
      qty: row.qtyUnit === "base" ? row.qty : null,
      source: inp.source,
      planHash: row.planHash,
    },
    {
      env: deps.env,
      maxOrderUsd: deps.maxOrderUsd,
      mandate,
      assertion,
      tradesToday,
      riskyValue,
      ...(exposure ? { hedgeableValue: exposure.holdingValue, existingShortUsd: exposure.existingShortUsd } : {}),
      ...(ownedShortQty !== undefined ? { ownedShortQty } : {}),
      beta,
      userLeverageCap: deps.userLeverageCap,
    },
  );
}

const approvalSchema = z.object({ assertion: z.unknown(), credentialId: z.string() });

/**
 * True when the stored terms hash to the stored mandate hash and the user's passkey signed that hash.
 * A mandate row edited after signing (wider perps, higher leverage) fails here and automation stops.
 */
export async function mandateIsAuthentic(m: SignedMandate, userId: string, deps: PolicyDeps): Promise<boolean> {
  const hash = mandateHash(m.terms);
  if (hash !== m.storedHash) return false;
  // Keyed by the recomputed hash too, so terms edited after a successful check are re-verified (and fail).
  const cacheKey = `${m.id}:${hash}`;
  if (deps.verifiedMandates?.has(cacheKey)) return true;
  const a = approvalSchema.safeParse(m.approval);
  if (!a.success) return false;
  const pk = await deps.getPasskey(userId, a.data.credentialId);
  if (!pk) return false;
  try {
    const v = await (deps.verify ?? verifyAuthenticationResponse)({
      response: a.data.assertion as AuthenticationResponseJSON,
      expectedChallenge: planChallenge(hash),
      expectedOrigin: deps.origin,
      expectedRPID: deps.rpID,
      requireUserVerification: true,
      credential: { id: pk.credentialId, publicKey: new Uint8Array(pk.publicKey), counter: 0 },
    });
    if (!v.verified) return false;
  } catch {
    return false;
  }
  deps.verifiedMandates?.add(cacheKey);
  return true;
}
