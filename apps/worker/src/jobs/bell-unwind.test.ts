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
    const d = unwindDrafts({ hedgeId: "hg", userId: "u", openInputs: inputs, planHash: "h" });
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ kind: "close", side: "buy", reduceOnly: true, qty: "0.06", planHash: "h" });
    expect(d[0]!.inputs).toMatchObject({ plan, assertion: { id: "c" }, credentialId: "c", notionalUsd: "10" });
  });

  it("does nothing for non-Bell plans or plans without close legs", () => {
    expect(unwindDrafts({ hedgeId: "hg", userId: "u", openInputs: { ...inputs, plan: { ...plan, kind: "shield" } }, planHash: "h" })).toEqual([]);
    expect(unwindDrafts({ hedgeId: "hg", userId: "u", openInputs: { ...inputs, plan: { ...plan, legs: [plan.legs[0]] } }, planHash: "h" })).toEqual([]);
  });
});
