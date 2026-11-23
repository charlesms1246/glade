import { mandateCheck, type ActiveMandate, type CheckResult } from "@glade/engine";
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
  leverage: z.union([z.string(), z.number()]).optional(),
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

export interface PolicyDeps {
  /** Execution environment. Production is always refused by the engine. */
  env: "paper" | "uat" | "prod";
  maxOrderUsd: string;
  /** Leverage cap for user-approved plans without a mandate. */
  userLeverageCap: string;
  origin: string;
  rpID: string;
  getPasskey: (userId: string, credentialId: string) => Promise<StoredPasskey | null>;
  getActiveMandate: (userId: string) => Promise<ActiveMandate | null>;
  tradesToday: (userId: string, now: Date) => Promise<number>;
  riskyValue: (userId: string) => Promise<string>;
  verify?: typeof verifyAuthenticationResponse;
}

const deny = (...reasons: string[]): CheckResult => ({ ok: false, reasons });

/** The signing policy for one stored intent. Nothing is stamped unless this returns ok. */
export async function authorizeIntent(row: IntentRow, deps: PolicyDeps, now: Date): Promise<CheckResult> {
  const parsed = inputsSchema.safeParse(row.inputs);
  if (!parsed.success) return deny("intent inputs are malformed");
  const inp = parsed.data;
  const spot = row.kind === "spot_buy" || row.kind === "spot_sell";

  let assertion: { planHash: string; approvedAssetIds: string[] } | null = null;
  let beta = inp.beta ?? "1";

  if (inp.source === "user") {
    const plan = planSchema.safeParse(inp.plan);
    if (!plan.success) return deny("approved plan is malformed");
    const hash = planHash(inp.plan);
    if (hash !== row.planHash || hash !== inp.planHash) return deny("plan hash does not match the approved plan");

    const leg = plan.data.legs.find(
      (l) => l.assetId === row.assetId && l.side === row.side && l.reduceOnly === row.reduceOnly && dec(l.qty).eq(dec(row.qty)),
    );
    if (!leg) return deny("intent is not a leg of the approved plan");
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

  const [mandate, tradesToday, riskyValue] = await Promise.all([
    inp.source === "automation" ? deps.getActiveMandate(row.userId) : Promise.resolve(null),
    deps.tradesToday(row.userId, now),
    deps.riskyValue(row.userId),
  ]);

  return mandateCheck(
    {
      kind: row.kind,
      side: row.side,
      assetId: row.assetId,
      instrument: spot ? "spot" : "perp",
      reduceOnly: row.reduceOnly,
      leverage: row.leverage,
      notionalUsd: inp.notionalUsd,
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
      beta,
      userLeverageCap: deps.userLeverageCap,
    },
  );
}
