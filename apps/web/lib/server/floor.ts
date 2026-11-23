import "server-only";
import { schema } from "@glade/db";
import { chooseInstrument, cppiStep, CPPI_DEFAULTS, liquidationDistance, mandateHash, type MandateTerms } from "@glade/engine";
import { dec, Decimal } from "@glade/shared";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "./db";
import { perpListings } from "./market";
import { mac, macOk } from "./session";
import { stockHoldings } from "./shield";
import { venueFor } from "./venue";
import { planAssertionOptions, verifyPlanAssertion } from "./webauthn";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";

export const FLOOR_DEFAULTS = { floorPct: "0.85", multiplier: "4", ratchet: true, leverageMax: "3", maxTradesDay: 10 } as const;
export const LEVERAGE_CAP = 3;
const LIQ_AT_RISK = new Decimal("0.15");
const OFFER_TTL_MS = 5 * 60_000;

export interface FloorChoice {
  floorPct: string;
  multiplier: string;
  ratchet: boolean;
  leverageMax: string;
}

export interface MandateOffer {
  terms: MandateTerms & { floorPct: string; multiplier: string; baseUsd: string; leverageMax: string };
  perps: { assetId: string; symbol: string; hedges: string[] }[];
  hash: string;
  issuedAt: string;
  tag: string;
}

export interface MandateView {
  id: string;
  version: number;
  status: "active" | "paused" | "revoked";
  floorPct: string;
  multiplier: string;
  ratchet: boolean;
  baseUsd: string;
  leverageMax: string;
  allowedPerps: string[];
  perpSymbols: string[];
  maxTradesDay: number;
  signedAt: string;
}

export interface RiskView {
  equityUsd: string;
  targetUsd: string;
  peakUsd: string;
  cushionUsd: string;
  cushionRatio: string;
  hedgeTargetUsd: string;
  hedgeNowUsd: string;
  minLiqDistance: string | null;
  targetAtRisk: boolean;
  liquidationAtRisk: boolean;
}

export interface FloorLogItem {
  id: number;
  at: string;
  action: string;
  explanation: string;
}

export interface FloorView {
  mandate: MandateView | null;
  risk: RiskView | null;
  log: FloorLogItem[];
}

const norm = (v: string) => dec(v).toString();

/** The perp the engine would hedge each holding with: matched single-stock perp, else index. */
async function enginePerps(userId: string) {
  const [{ groups }, perps] = await Promise.all([stockHoldings(userId), perpListings()]);
  const out = new Map<string, { assetId: string; symbol: string; hedges: string[] }>();
  for (const g of groups) {
    const leg = chooseInstrument(g, perps);
    if (!leg) continue;
    const cur = out.get(leg.perp_asset_id) ?? { assetId: leg.perp_asset_id, symbol: leg.perp_symbol, hedges: [] };
    cur.hedges.push(g.symbol);
    out.set(leg.perp_asset_id, cur);
  }
  return [...out.values()];
}

export function validChoice(c: FloorChoice): string | null {
  const f = dec(c.floorPct);
  const m = dec(c.multiplier);
  const l = dec(c.leverageMax);
  if (f.lt("0.5") || f.gt("0.99")) return "The target must be between 50% and 99% of equity.";
  if (m.lt(1) || m.gt(10)) return "The multiplier must be between 1 and 10.";
  if (l.lt(1) || l.gt(LEVERAGE_CAP)) return `Leverage must be between 1× and ${LEVERAGE_CAP}×.`;
  return null;
}

/** Mandate terms for the user's current holdings, hashed and tagged for a passkey signature. */
export async function offerMandate(userId: string, c: FloorChoice) {
  const [portfolio, perps, [maxV]] = await Promise.all([
    venueFor(userId).portfolio(),
    enginePerps(userId),
    db().select({ v: sql<number | null>`max(${schema.mandates.version})` }).from(schema.mandates).where(eq(schema.mandates.userId, userId)),
  ]);
  if (perps.length === 0) return { error: "You hold no stocks that can be hedged. Buy one first." };
  const terms = {
    userId,
    version: (maxV?.v ?? 0) + 1,
    floorPct: norm(c.floorPct),
    multiplier: norm(c.multiplier),
    ratchet: c.ratchet,
    baseUsd: norm(dec(portfolio.total_usd ?? "0").toFixed(2, Decimal.ROUND_DOWN)),
    leverageMax: norm(c.leverageMax),
    allowedPerps: perps.map((p) => p.assetId),
    maxTradesDay: FLOOR_DEFAULTS.maxTradesDay,
  };
  const hash = mandateHash(terms);
  const issuedAt = new Date().toISOString();
  const offer: MandateOffer = { terms, perps, hash, issuedAt, tag: mac(`${hash}.${issuedAt}`) };
  return { ...offer, passkey: await planAssertionOptions(userId, hash) };
}

/** Verify a signed mandate and make it the user's only active one. */
export async function signMandate(
  userId: string,
  body: { terms: MandateTerms; issuedAt: string; tag: string; assertion: AuthenticationResponseJSON } | null,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  if (!body?.terms || !body.tag || !body.issuedAt || !body.assertion?.id) return { ok: false, error: "Missing mandate or passkey signature." };
  const hash = mandateHash(body.terms);
  if (!macOk(`${hash}.${body.issuedAt}`, body.tag) || body.terms.userId !== userId) return { ok: false, error: "This mandate was not issued to you." };
  if (Date.now() - Date.parse(body.issuedAt) > OFFER_TTL_MS) return { ok: false, error: "This mandate expired. Review it again." };
  if (!(await verifyPlanAssertion(userId, body.assertion, hash))) return { ok: false, error: "The passkey signature did not verify." };
  const t = body.terms;
  try {
    const id = await db().transaction(async (tx) => {
      const now = new Date();
      await tx
        .update(schema.mandates)
        .set({ status: "revoked", revokedAt: now })
        .where(and(eq(schema.mandates.userId, userId), ne(schema.mandates.status, "revoked")));
      const [row] = await tx
        .insert(schema.mandates)
        .values({
          userId,
          version: t.version,
          floorPct: String(t.floorPct),
          multiplier: String(t.multiplier),
          ratchet: t.ratchet,
          baseUsd: String(t.baseUsd),
          leverageMax: String(t.leverageMax),
          allowedPerps: [...t.allowedPerps],
          maxTradesDay: t.maxTradesDay,
          status: "active",
          mandateHash: hash,
          webauthnAssertion: { assertion: body.assertion, credentialId: body.assertion.id },
          signedAt: now,
        })
        .returning({ id: schema.mandates.id });
      await tx.delete(schema.floorState).where(eq(schema.floorState.userId, userId));
      return row!.id;
    });
    return { ok: true, id };
  } catch {
    return { ok: false, error: "A newer mandate was signed meanwhile. Review it again." };
  }
}

/** Pause or revoke the user's current mandate. Open hedges stay until the user unshields. */
export async function setMandateStatus(userId: string, status: "paused" | "revoked") {
  const from: ("active" | "paused")[] = status === "paused" ? ["active"] : ["active", "paused"];
  const rows = await db()
    .update(schema.mandates)
    .set({ status, ...(status === "revoked" ? { revokedAt: new Date() } : {}) })
    .where(and(eq(schema.mandates.userId, userId), inArray(schema.mandates.status, from)))
    .returning({ id: schema.mandates.id });
  return rows.length > 0;
}

export async function floorView(userId: string): Promise<FloorView> {
  const [m] = await db()
    .select()
    .from(schema.mandates)
    .where(and(eq(schema.mandates.userId, userId), ne(schema.mandates.status, "revoked")))
    .orderBy(desc(schema.mandates.version))
    .limit(1);
  const log = await floorLog(userId);
  if (!m) return { mandate: null, risk: null, log };

  const venue = venueFor(userId);
  const [portfolio, positions, { groups }, perps, [state]] = await Promise.all([
    venue.portfolio(),
    venue.positions(),
    stockHoldings(userId),
    perpListings(),
    db().select().from(schema.floorState).where(eq(schema.floorState.userId, userId)),
  ]);
  const symbolOf = new Map(perps.map((p) => [p.asset_id, p.symbol]));
  const allowed = new Set(m.allowedPerps);

  // Same inputs as the worker's Floor job: holdings hedged by an allowed perp, and the shorts on those perps.
  const legs = groups.map((g) => ({ g, leg: chooseInstrument(g, perps) })).filter((x) => x.leg && allowed.has(x.leg.perp_asset_id));
  const riskyValue = legs.reduce((a, l) => a.plus(l.g.value), dec(0));
  const shorts = positions.filter((p) => p.side === "short" && p.asset_id && allowed.has(p.asset_id) && p.size);
  const hedgeNow = shorts.reduce((a, p) => a.plus(dec(p.size!).mul(dec(p.mark_price ?? "0"))), dec(0));
  const equity = dec(portfolio.total_usd ?? "0");

  const r = cppiStep(
    { peak: state?.peakUsd ? dec(state.peakUsd) : null, lastTradeAt: null, tradesToday: 0 },
    { equity, riskyValue, hedgeNow, legs: legs.map((l) => ({ key: l.leg!.perp_asset_id, beta: l.leg!.beta, value: l.g.value })) },
    {
      base: m.baseUsd,
      floorPct: m.floorPct,
      multiplier: m.multiplier,
      ratchet: m.ratchet,
      band: process.env.FLOOR_BAND ?? CPPI_DEFAULTS.band,
      minNotionalUsd: process.env.MIN_PERP_NOTIONAL_USD ?? "10",
      cooldownSec: CPPI_DEFAULTS.cooldownSec,
      maxTradesDay: m.maxTradesDay,
    },
    new Date(),
  );
  const liqs = shorts
    .filter((p) => p.mark_price && p.liquidation_price)
    .map((p) => liquidationDistance(p.mark_price!, p.liquidation_price!));
  const minLiq = liqs.length ? Decimal.min(...liqs) : null;

  return {
    mandate: {
      id: m.id,
      version: m.version,
      status: m.status,
      floorPct: dec(m.floorPct).toString(),
      multiplier: dec(m.multiplier).toString(),
      ratchet: m.ratchet,
      baseUsd: dec(m.baseUsd).toFixed(2),
      leverageMax: dec(m.leverageMax).toString(),
      allowedPerps: m.allowedPerps,
      perpSymbols: m.allowedPerps.map((id) => symbolOf.get(id) ?? id),
      maxTradesDay: m.maxTradesDay,
      signedAt: m.signedAt.toISOString(),
    },
    risk: {
      equityUsd: equity.toFixed(2),
      targetUsd: r.floor.toFixed(2),
      peakUsd: r.peak.toFixed(2),
      cushionUsd: r.cushion.toFixed(2),
      cushionRatio: r.cushionRatio.toFixed(4),
      hedgeTargetUsd: r.hedgeTarget.toFixed(2),
      hedgeNowUsd: hedgeNow.toFixed(2),
      minLiqDistance: minLiq?.toFixed(4) ?? null,
      targetAtRisk: r.floorAtRisk,
      liquidationAtRisk: minLiq ? minLiq.lt(LIQ_AT_RISK) : false,
    },
    log,
  };
}

/** Floor decisions plus the results of orders the Floor loop placed, newest first. */
async function floorLog(userId: string, limit = 30): Promise<FloorLogItem[]> {
  const d = schema.decisions;
  const automated = sql`select ${schema.intents.id}::text from ${schema.intents} where ${schema.intents.userId} = ${userId} and ${schema.intents.inputs}->>'source' = 'automation'`;
  const rows = await db()
    .select({ id: d.id, at: d.at, action: d.action, explanation: d.explanation })
    .from(d)
    .where(
      and(
        eq(d.userId, userId),
        sql`(${d.action} in ('floor_rebalance', 'floor_at_risk') or (${d.action} like 'intent\\_%' and ${d.inputs}->>'intentId' in (${automated})))`,
      ),
    )
    .orderBy(desc(d.at))
    .limit(limit);
  return rows.map((r) => ({ id: r.id, at: r.at.toISOString(), action: r.action, explanation: r.explanation }));
}
