import { describe, expect, it } from "vitest";
import { unwindDrafts } from "./bell-unwind";

const plan = {
  kind: "bell",
  assetIds: ["p"],
  legs: [
    { assetId: "p", side: "sell", qty: "0.06", reduceOnly: false, notionalUsd: "10", beta: "1", leverage: "2" },
    { assetId: "p", side: "buy", qty: "0.06", reduceOnly: true, notionalUsd: "10", beta: "1" },
  ],
};
const inputs = { source: "user", notionalUsd: "10", planHash: "h", plan, assertion: { id: "c" }, credentialId: "c" };

describe("bell unwind", () => {
  it("produces only the approved reduce-only close legs, reusing the approval", () => {
    const d = unwindDrafts({ hedgeId: "hg", userId: "u", openInputs: inputs, planHash: "h", doneOpens: [{ assetId: "p", qty: "0.06" }], doneCloses: [] });
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ kind: "close", side: "buy", reduceOnly: true, qty: "0.06", planHash: "h" });
    expect(d[0]!.inputs).toMatchObject({ plan, assertion: { id: "c" }, credentialId: "c", notionalUsd: "10" });
  });

  it("does nothing for non-Bell plans or plans without close legs", () => {
    expect(unwindDrafts({ hedgeId: "hg", userId: "u", openInputs: { ...inputs, plan: { ...plan, kind: "shield" } }, planHash: "h", doneOpens: [{ assetId: "p", qty: "0.06" }], doneCloses: [] })).toEqual([]);
    expect(unwindDrafts({ hedgeId: "hg", userId: "u", openInputs: { ...inputs, plan: { ...plan, legs: [plan.legs[0]] } }, planHash: "h", doneOpens: [{ assetId: "p", qty: "0.06" }], doneCloses: [] })).toEqual([]);
  });
});

describe("bell unwind leg selection", () => {
  const twoLegs = {
    ...plan,
    assetIds: ["p", "q"],
    legs: [
      ...plan.legs,
      { assetId: "q", side: "sell", qty: "1", reduceOnly: false, notionalUsd: "10", beta: "1", leverage: "2" },
      { assetId: "q", side: "buy", qty: "1", reduceOnly: true, notionalUsd: "10", beta: "1" },
    ],
  };
  const base = { hedgeId: "hg", userId: "u", openInputs: { ...inputs, plan: twoLegs }, planHash: "h" };

  it("closes only legs whose open filled", () => {
    const d = unwindDrafts({ ...base, doneOpens: [{ assetId: "q", qty: "1.000000000000000000" }], doneCloses: [] });
    expect(d.map((x) => x.assetId)).toEqual(["q"]);
  });

  it("on retry, skips legs already closed", () => {
    const d = unwindDrafts({ ...base, doneOpens: [{ assetId: "p", qty: "0.06" }, { assetId: "q", qty: "1" }], doneCloses: [{ assetId: "p", qty: "0.06" }] });
    expect(d.map((x) => x.assetId)).toEqual(["q"]);
  });
});

import { runBellUnwind, unwindPlan, type DueHedge } from "./bell-unwind";

describe("unwindPlan", () => {
  const h = (over: Partial<DueHedge> = {}): DueHedge => ({ hedgeId: "hg", userId: "u", openInputs: inputs, planHash: "h", doneOpens: [{ assetId: "p", qty: "0.060000000000000000" }], doneCloses: [], ...over });

  it("is done only when every filled open has a filled close", () => {
    expect(unwindPlan(h()).done).toBe(false);
    expect(unwindPlan(h({ doneCloses: [{ assetId: "p", qty: "0.06" }] })).done).toBe(true);
    expect(unwindPlan(h({ doneOpens: [] })).done).toBe(true);
  });
  it("is never done for an unusable plan, and says why", () => {
    expect(unwindPlan(h({ openInputs: { ...inputs, plan: { ...plan, kind: "shield" } } }))).toMatchObject({ done: false, drafts: [], invalid: expect.any(String) });
    expect(unwindPlan(h({ openInputs: {} })).done).toBe(false);
    expect(unwindPlan(h({ openInputs: { ...inputs, plan: { ...plan, legs: [plan.legs[0]] } } })).invalid).toMatch(/no approved close leg/);
  });
  it("counts failures per leg", () => {
    const two = { ...plan, legs: [...plan.legs, { assetId: "q", side: "sell", qty: "1", reduceOnly: false, notionalUsd: "10", beta: "1", leverage: "2" }, { assetId: "q", side: "buy", qty: "1", reduceOnly: true, notionalUsd: "10", beta: "1" }] };
    const p = unwindPlan(h({ openInputs: { ...inputs, plan: two }, doneOpens: [{ assetId: "p", qty: "0.06" }, { assetId: "q", qty: "1" }], failedByLeg: [{ assetId: "p", qty: "0.06", n: 3 }, { assetId: "q", qty: "1", n: 1 }] }), 3);
    expect(p.exhausted.map((x) => x.assetId)).toEqual(["p"]);
    expect(p.drafts.map((x) => x.assetId)).toEqual(["q"]);
  });
});

describe("runBellUnwind", () => {
  const mk = (hedge: DueHedge & { failedByLeg: { assetId: string; qty: string; n: number }[] }, over: Partial<Parameters<typeof runBellUnwind>[0]> = {}) => {
    const calls = { closed: [] as string[], inserted: 0, alerts: 0 };
    let alerted = false;
    const d = {
      due: async () => [hedge],
      insertCloses: async (x: unknown[]) => void (calls.inserted += x.length),
      markClosed: async (id: string) => void calls.closed.push(id),
      alreadyAlerted: async () => alerted,
      alert: async () => void (calls.alerts++, (alerted = true)),
      paused: () => false,
      maxAttempts: 3,
      ...over,
    };
    return { d, calls };
  };
  const base = { hedgeId: "hg", userId: "u", openInputs: inputs, planHash: "h", doneOpens: [{ assetId: "p", qty: "0.06" }], doneCloses: [], failedByLeg: [] };

  it("does not mark a hedge closed when the plan is unusable, and alerts once", async () => {
    const { d, calls } = mk({ ...base, openInputs: {} });
    await runBellUnwind(d);
    await runBellUnwind(d);
    expect(calls.closed).toEqual([]);
    expect(calls.alerts).toBe(1);
  });
  it("marks closed when all legs closed, and does nothing while paused", async () => {
    const { d, calls } = mk({ ...base, doneCloses: [{ assetId: "p", qty: "0.06" }] });
    await runBellUnwind({ ...d, paused: () => true });
    expect(calls.closed).toEqual([]);
    await runBellUnwind(d);
    expect(calls.closed).toEqual(["hg"]);
  });
  it("stops retrying a leg after the cap and alerts", async () => {
    const { d, calls } = mk({ ...base, failedByLeg: [{ assetId: "p", qty: "0.06", n: 3 }] });
    await runBellUnwind(d);
    expect(calls).toMatchObject({ inserted: 0, alerts: 1, closed: [] });
  });
});
