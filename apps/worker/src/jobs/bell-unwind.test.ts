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
