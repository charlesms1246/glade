import { describe, expect, it } from "vitest";
import type { FloorInputs } from "./decide";
import { runFloorJob, type FloorJobDeps, type FloorUser } from "./job";

const user: FloorUser = {
  userId: "u",
  mandate: { floorPct: "0.85", multiplier: "4", ratchet: true, baseUsd: "1000", leverageMax: "3", allowedPerps: ["p"], maxTradesDay: 10 },
  state: { peak: null, lastTradeAt: null, tradesToday: 3, tradesDay: "2026-11-23" },
};
const thin: FloorInputs = {
  equity: "900",
  holdings: [{ asset_id: "a", economic_asset_id: "e", symbol: "NVDA", value: "900" }],
  positions: [],
  perps: [{ asset_id: "p", symbol: "NVDA" }],
  marks: { p: "100" },
};
const now = new Date("2026-11-24T15:00:00Z");

function deps(over: Partial<FloorJobDeps> = {}) {
  const calls: { inserted: number; saved: unknown[]; logged: number } = { inserted: 0, saved: [], logged: 0 };
  const d: FloorJobDeps = {
    activeUsers: async () => [user],
    inputs: async () => thin,
    hasOpenIntents: async () => false,
    insertIntents: async (_u, drafts) => void (calls.inserted += drafts.length),
    saveState: async (_u, s) => void calls.saved.push(s),
    logDecision: async () => void calls.logged++,
    params: { band: "0.05", cooldownSec: 600, minNotionalUsd: "10", leverage: "2", sizeStep: () => "0.001" },
    paused: () => false,
    ...over,
  };
  return { d, calls };
}

describe("Floor job", () => {
  it("inserts intents, resets the daily count on a new day and records the trade", async () => {
    const { d, calls } = deps();
    expect(await runFloorJob(d, now)).toEqual({ traded: ["u"], idle: [] });
    expect(calls.inserted).toBe(1);
    expect(calls.saved[0]).toMatchObject({ lastTradeAt: now, tradesDay: "2026-11-24", tradesToday: 1, peak: "1000" });
    expect(calls.logged).toBe(1);
  });

  it("does nothing while paused or while the user has unfinished intents", async () => {
    const paused = deps({ paused: () => true });
    expect(await runFloorJob(paused.d, now)).toEqual({ traded: [], idle: [] });
    const busy = deps({ hasOpenIntents: async () => true });
    expect(await runFloorJob(busy.d, now)).toEqual({ traded: [], idle: ["u"] });
    expect(busy.calls.inserted).toBe(0);
  });

  it("keeps going when one user fails", async () => {
    const { d } = deps({
      activeUsers: async () => [{ ...user, userId: "bad" }, user],
      inputs: async (id) => {
        if (id === "bad") throw new Error("venue down");
        return thin;
      },
    });
    expect((await runFloorJob(d, now)).traded).toEqual(["u"]);
  });
});
