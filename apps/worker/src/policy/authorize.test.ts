import { planHash } from "@glade/shared";
import { describe, expect, it } from "vitest";
import { authorizeIntent, type IntentRow, type PolicyDeps } from "./authorize";

const plan = {
  kind: "shield",
  ratio: "0.75",
  assetIds: ["perp-nvda"],
  legs: [{ assetId: "perp-nvda", side: "sell", qty: "0.06", reduceOnly: false, notionalUsd: "10", beta: "1", leverage: "2" }],
};
const hash = planHash(plan);

const row = (over: Partial<IntentRow> = {}, inputs: Record<string, unknown> = {}): IntentRow => ({
  id: "i1",
  userId: "u1",
  kind: "open",
  assetId: "perp-nvda",
  side: "sell",
  qty: "0.06",
  leverage: "2",
  reduceOnly: false,
  planHash: hash,
  inputs: { source: "user", notionalUsd: "10", planHash: hash, plan, assertion: { id: "cred" }, credentialId: "cred", ...inputs },
  ...over,
});

function deps(over: Partial<PolicyDeps> = {}): PolicyDeps & { challenges: string[] } {
  const challenges: string[] = [];
  return {
    challenges,
    env: "paper",
    maxOrderUsd: "20",
    userLeverageCap: "3",
    origin: "http://localhost:3000",
    rpID: "localhost",
    getPasskey: async (_u, id) => (id === "cred" ? { credentialId: "cred", publicKey: new Uint8Array([1]) } : null),
    getActiveMandate: async () => null,
    tradesToday: async () => 0,
    riskyValue: async () => "13",
    verify: (async (o: { expectedChallenge: unknown }) => {
      challenges.push(String(o.expectedChallenge));
      return { verified: true };
    }) as unknown as PolicyDeps["verify"],
    ...over,
  };
}

describe("authorizeIntent (user-approved)", () => {
  it("approves a leg of a passkey-approved plan, with the plan hash as challenge", async () => {
    const d = deps();
    expect(await authorizeIntent(row(), d, new Date())).toEqual({ ok: true });
    expect(Buffer.from(d.challenges[0]!, "base64url").toString("hex")).toBe(hash);
  });

  it("rejects when the stored plan was altered after approval", async () => {
    const tampered = { ...plan, legs: [{ ...plan.legs[0]!, qty: "6" }] };
    expect(await authorizeIntent(row({}, { plan: tampered }), deps(), new Date())).toMatchObject({ ok: false });
  });

  it("rejects an intent that is not a leg of the plan", async () => {
    const r = await authorizeIntent(row({ qty: "0.6" }), deps(), new Date());
    expect(r).toEqual({ ok: false, reasons: ["intent is not a leg of the approved plan"] });
  });

  it("rejects when the passkey does not verify or is unknown", async () => {
    const bad = deps({ verify: (async () => ({ verified: false })) as unknown as PolicyDeps["verify"] });
    expect((await authorizeIntent(row(), bad, new Date())).ok).toBe(false);
    expect((await authorizeIntent(row({}, { credentialId: "other" }), deps(), new Date())).ok).toBe(false);
  });

  it("rejects production even with a valid approval", async () => {
    const r = await authorizeIntent(row(), deps({ env: "prod" }), new Date());
    expect(r).toEqual({ ok: false, reasons: ["production orders are never placed (no real money)"] });
  });

  it("rejects malformed inputs", async () => {
    expect((await authorizeIntent(row({}, { notionalUsd: 10 }), deps(), new Date())).ok).toBe(false);
  });
});

describe("authorizeIntent (automation)", () => {
  const auto = (over: Partial<IntentRow> = {}) =>
    row({ planHash: null, ...over, inputs: { source: "automation", notionalUsd: "10", beta: "1" } });

  it("needs an active mandate allowing the perp", async () => {
    expect((await authorizeIntent(auto(), deps(), new Date())).ok).toBe(false);
    const withMandate = deps({
      getActiveMandate: async () => ({ status: "active", allowedPerps: ["perp-nvda"], leverageMax: "3", maxTradesDay: 10 }),
    });
    expect(await authorizeIntent(auto(), withMandate, new Date())).toEqual({ ok: true });
  });

  it("never lets automation open a long perp", async () => {
    const withMandate = deps({
      getActiveMandate: async () => ({ status: "active", allowedPerps: ["perp-nvda"], leverageMax: "3", maxTradesDay: 10 }),
    });
    expect((await authorizeIntent(auto({ side: "buy", reduceOnly: false }), withMandate, new Date())).ok).toBe(false);
  });
});
