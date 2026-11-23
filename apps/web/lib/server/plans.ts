import "server-only";
import { schema, type Db } from "@glade/db";
import { planHash } from "@glade/shared";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "./db";
import { mac, macOk } from "./session";
import { planAssertionOptions, verifyPlanAssertion } from "./webauthn";

/** One order the plan may place. Amounts are decimal strings. */
export interface PlanLeg {
  assetId: string;
  symbol: string;
  side: "buy" | "sell";
  qty: string;
  qtyUnit: "quote" | "base";
  leverage?: string;
  reduceOnly: boolean;
  notionalUsd: string;
  beta: string;
}

export interface PlanBase {
  kind: string;
  userId: string;
  nonce: string;
  createdAt: string;
  assetIds: string[];
  legs: PlanLeg[];
}

const PLAN_TTL_MS = 5 * 60_000;

export const planHeader = (kind: string, userId: string, legs: PlanLeg[]) => ({
  kind,
  userId,
  nonce: randomUUID(),
  createdAt: new Date().toISOString(),
  assetIds: [...new Set(legs.map((l) => l.assetId))],
  legs,
});

/** Hash a plan, tag it so the server can trust it later, and build the passkey request over the hash. */
export async function offerPlan<P extends PlanBase>(plan: P) {
  const hash = planHash(plan);
  return { plan, hash, tag: mac(`plan:${hash}`), passkey: await planAssertionOptions(plan.userId, hash) };
}

export interface ApprovalBody<P> {
  plan: P;
  tag: string;
  assertion: AuthenticationResponseJSON;
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export interface Approved<P> {
  plan: P;
  hash: string;
  assertion: AuthenticationResponseJSON;
}

/**
 * Accept a plan this server issued to this user, still fresh, that passes `validate` and was approved with the
 * user's passkey, then run `write` once. Concurrent confirms of the same plan serialise on a lock keyed by the
 * plan hash, so at most one of them writes intents.
 */
export async function commitPlan<P extends PlanBase, R>(
  userId: string,
  body: ApprovalBody<P> | null,
  validate: (plan: P) => string | null,
  write: (tx: Tx, a: Approved<P>) => Promise<R>,
): Promise<{ ok: true; result: R } | { ok: false; error: string }> {
  if (!body?.plan || !body.tag || !body.assertion?.id) return { ok: false, error: "Missing plan or passkey approval." };
  const hash = planHash(body.plan);
  if (!macOk(`plan:${hash}`, body.tag) || body.plan.userId !== userId) return { ok: false, error: "This plan was not issued to you." };
  if (Date.now() - Date.parse(body.plan.createdAt) > PLAN_TTL_MS) return { ok: false, error: "This plan expired. Review a fresh one." };
  const invalid = validate(body.plan);
  if (invalid) return { ok: false, error: invalid };
  if (!(await verifyPlanAssertion(userId, body.assertion, hash))) return { ok: false, error: "The passkey approval did not verify." };

  const a = { plan: body.plan, hash, assertion: body.assertion };
  return db().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${hash}))`);
    const [used] = await tx.select({ id: schema.intents.id }).from(schema.intents).where(eq(schema.intents.planHash, hash)).limit(1);
    if (used) return { ok: false as const, error: "This plan was already approved." };
    return { ok: true as const, result: await write(tx, a) };
  });
}

/** The `intents.inputs` the worker re-verifies before acting. */
export const intentInputs = (a: { plan: PlanBase; hash: string; assertion: AuthenticationResponseJSON }, notionalUsd: string) => ({
  plan: a.plan,
  planHash: a.hash,
  notionalUsd,
  source: "user",
  assertion: a.assertion,
  credentialId: a.assertion.id,
});
