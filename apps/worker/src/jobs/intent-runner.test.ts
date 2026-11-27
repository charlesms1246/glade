import { describe, expect, it } from "vitest";
import { explainResult, runIntentsUntilEmpty, runPendingIntents, type ClaimedIntent } from "./intent-runner";

const intent = (id: string): ClaimedIntent => ({
  id,
  userId: "u",
  kind: "open",
  assetId: "perp",
  side: "sell",
  qty: "0.06",
  qtyUnit: "base",
  leverage: "2",
  reduceOnly: false,
  planHash: "h",
  inputs: {},
  hedgeId: "h1",
  reason: "Shield 75% of NVDA.",
});

describe("intent runner", () => {
  it("executes claimed intents in order and reports every result", async () => {
    const seen: string[] = [];
    const r = await runPendingIntents({
      claim: async () => [intent("a"), intent("b")],
      execute: async (i) => (seen.push(i.id), { outcome: "complete", tmOrderId: `o-${i.id}`, row: { intentId: i.id, attempt: 1, tmOrderId: `o-${i.id}`, status: "complete" } }),
      onResult: async (i, res) => void seen.push(`${i.id}:${res.outcome}`),
    });
    expect(seen).toEqual(["a", "a:complete", "b", "b:complete"]);
    expect(r).toHaveLength(2);
  });

  it("turns a thrown error into a failed result and continues", async () => {
    const outcomes: string[] = [];
    await runPendingIntents({
      claim: async () => [intent("a"), intent("b")],
      execute: async (i) => {
        if (i.id === "a") throw new Error("boom");
        return { outcome: "rejected", reasons: ["no active mandate"] };
      },
      onResult: async (_i, res) => void outcomes.push(res.outcome),
    });
    expect(outcomes).toEqual(["failed", "rejected"]);
  });

  it("explains results in plain English", () => {
    expect(explainResult(intent("a"), { outcome: "rejected", reasons: ["leverage above cap"] })).toBe(
      "Not placed: open sell 0.06. Blocked by policy: leverage above cap.",
    );
    expect(
      explainResult(intent("a"), { outcome: "complete", tmOrderId: "o", row: { intentId: "a", attempt: 1, tmOrderId: "o", status: "complete", avgPrice: "164.2", fee: "0.004" } }),
    ).toBe("Filled: open sell 0.06 at 164.2, fee 0.004. Shield 75% of NVDA.");
  });
});

describe("explainResult formatting", () => {
  it("trims database-scale decimals", () => {
    const i = { ...intent("a"), qty: "3.629000000000000000" };
    const row = { intentId: "a", attempt: 1, tmOrderId: "o", status: "complete" as const, avgPrice: "165.165000", fee: "0.26972270325" };
    expect(explainResult(i, { outcome: "complete", tmOrderId: "o", row })).toBe("Filled: open sell 3.629 at 165.165, fee 0.2697. Shield 75% of NVDA.");
  });
});

describe("runIntentsUntilEmpty", () => {
  it("drains the queue one at a time and stops at the cap", async () => {
    const mk = (id: string) => ({ id, userId: "u", kind: "open", assetId: "p", side: "sell", qty: "1", qtyUnit: "base", leverage: null, reduceOnly: false, planHash: null, inputs: {}, hedgeId: null, reason: "" }) as unknown as ClaimedIntent;
    const queue = ["a", "b", "c"].map(mk);
    const sizes: number[] = [];
    const deps = {
      claim: async (n: number) => (sizes.push(n), queue.splice(0, n)),
      execute: async () => ({ outcome: "failed" as const, reason: "x" }),
      onResult: async () => {},
    };
    expect(await runIntentsUntilEmpty(deps, 20)).toHaveLength(3);
    expect(sizes.every((n) => n === 1)).toBe(true);
    queue.push(...["d", "e", "f"].map(mk));
    expect(await runIntentsUntilEmpty(deps, 2)).toHaveLength(2);
  });
});
