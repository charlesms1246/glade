import { createHash } from "node:crypto";
import { Decimal, dec, type DecimalLike, type IntentKind, type Side, type TmEnv } from "@glade/shared";

export interface MandateTerms {
  userId: string;
  version: number;
  floorPct: DecimalLike;
  multiplier: DecimalLike;
  ratchet: boolean;
  baseUsd: DecimalLike;
  leverageMax: DecimalLike;
  allowedPerps: readonly string[];
  maxTradesDay: number;
}

export interface ActiveMandate {
  status: "active" | "paused" | "revoked";
  allowedPerps: readonly string[];
  leverageMax: DecimalLike;
  maxTradesDay: number;
}

export interface CheckIntent {
  kind: IntentKind | "transfer";
  side: Side;
  /** Perp or spot asset id the order targets. */
  assetId: string;
  instrument: "perp" | "spot" | "transfer";
  reduceOnly: boolean;
  leverage: DecimalLike | null;
  notionalUsd: DecimalLike;
  /** "automation" = Floor/Bell loops; "user" = a fresh, user-approved plan. */
  source: "automation" | "user";
  planHash: string | null;
}

export interface CheckContext {
  env: TmEnv;
  allowProd: boolean;
  maxOrderUsd: DecimalLike;
  mandate: ActiveMandate | null;
  /** Present when the user just approved a plan with a passkey assertion. */
  assertion: { planHash: string; approvedAssetIds: readonly string[] } | null;
  tradesToday: number;
  riskyValue: DecimalLike;
  /** Beta of the holding this instrument hedges. */
  beta: DecimalLike;
  /** Hard leverage cap for user-approved plans without a mandate. */
  userLeverageCap: DecimalLike;
}

export type CheckResult = { ok: true } | { ok: false; reasons: string[] };

const NOTIONAL_HEADROOM = new Decimal("1.05");

/** Signing policy. Nothing is stamped unless this returns ok. */
export function mandateCheck(intent: CheckIntent, ctx: CheckContext): CheckResult {
  const reasons: string[] = [];
  const notional = dec(intent.notionalUsd);

  if (intent.instrument === "transfer" || intent.kind === "transfer")
    return { ok: false, reasons: ["transfers are never signed"] };

  const opensRisk = intent.instrument === "perp" && intent.side === "sell" && !intent.reduceOnly;
  const reduces = intent.instrument === "perp" && intent.side === "buy" && intent.reduceOnly;

  if (intent.instrument === "perp" && !opensRisk && !reduces)
    reasons.push("perp orders must be a short (sell) or a reduce-only buy");
  if (notional.lte(0)) reasons.push("notional must be positive");

  if (intent.source === "automation") {
    const m = ctx.mandate;
    if (!m || m.status !== "active") reasons.push("no active mandate");
    if (intent.instrument !== "perp") reasons.push("automation may not trade spot");
    if (m && !m.allowedPerps.includes(intent.assetId)) reasons.push("instrument not allowed by mandate");
    if (m && opensRisk && (intent.leverage === null || dec(intent.leverage).gt(dec(m.leverageMax))))
      reasons.push("leverage above mandate cap");
    if (m && ctx.tradesToday >= m.maxTradesDay) reasons.push("daily trade cap reached");
  } else {
    const a = ctx.assertion;
    if (!a || !intent.planHash || a.planHash !== intent.planHash)
      reasons.push("no matching user approval");
    if (a && !a.approvedAssetIds.includes(intent.assetId)) reasons.push("asset not in approved plan");
    if (opensRisk && (intent.leverage === null || dec(intent.leverage).gt(dec(ctx.userLeverageCap))))
      reasons.push("leverage above cap");
  }

  if (opensRisk && notional.gt(NOTIONAL_HEADROOM.mul(dec(ctx.riskyValue)).mul(dec(ctx.beta))))
    reasons.push("notional exceeds 1.05 × holdings × beta");

  if (ctx.env === "prod") {
    if (!ctx.allowProd) reasons.push("production orders disabled (ALLOW_PROD)");
    if (notional.gt(dec(ctx.maxOrderUsd))) reasons.push("notional above MAX_ORDER_USD");
  }

  return reasons.length ? { ok: false, reasons } : { ok: true };
}

function canonical(v: unknown): unknown {
  if (v instanceof Decimal) return v.toString();
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v as object)
        .sort()
        .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
    );
  }
  if (typeof v === "number") return String(v);
  return v;
}

/** Deterministic JSON for a mandate: sorted keys, numbers and decimals as strings. */
export function canonicalMandateJson(terms: MandateTerms): string {
  return JSON.stringify(
    canonical({ ...terms, allowedPerps: [...terms.allowedPerps].sort() }),
  );
}

/** sha256 hex of the canonical mandate; used as the passkey challenge. */
export function mandateHash(terms: MandateTerms): string {
  return createHash("sha256").update(canonicalMandateJson(terms)).digest("hex");
}
