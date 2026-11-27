import { dec } from "@glade/shared";
import { describe, expect, it } from "vitest";
import { runBellReportJob, type BellReportJobDeps, type BellReportRow, type PendingBellHedge } from "./job";

const hedge: PendingBellHedge = {
  hedgeId: "h1",
  userId: "u1",
  sessionId: "s1",
  sessionKind: "overnight",
  openAt: new Date("2026-11-24T14:30:00Z"),
  openedAt: new Date("2026-11-24T02:00:00Z"),
  closedAt: new Date("2026-11-24T14:35:10Z"),
  plan: {
    kind: "bell",
    rows: [{ symbol: "NVDAx", valueUsd: "1000", perpSymbol: "NVDA", rejected: null }],
    legs: [
      { assetId: "p-nvda", symbol: "NVDA", reduceOnly: false },
      { assetId: "p-nvda", symbol: "NVDA", reduceOnly: true },
    ],
  },
  fills: [
    { assetId: "p-nvda", kind: "open", executedQty: "10", avgPrice: "101", fee: "0.45" },
    { assetId: "p-nvda", kind: "close", executedQty: "10", avgPrice: "103", fee: "0.46" },
  ],
};

function deps(over: Partial<BellReportJobDeps> = {}) {
  const rows: BellReportRow[] = [];
  const decisions: { userId: string; explanation: string }[] = [];
  const priceCalls: string[] = [];
  const d: BellReportJobDeps = {
    pending: async () => [hedge],
    snapshots: async () => [
      { symbol: "NVDA", closePx: "100", basis: "0" },
      { symbol: "AAPL", closePx: "200", basis: "0" },
    ],
    spotPriceAt: async (sym, at) => (priceCalls.push(`${sym}@${at.toISOString()}`), "102"),
    fundingReceived: async () => "0.1",
    insertReport: async (r) => (rows.push(r), true),
    logDecision: async (userId, x) => void decisions.push({ userId, explanation: x.explanation }),
    sigma: { overnight: dec("0.0232"), weekend: dec("0.0914"), holiday: dec("0.0914") },
    ...over,
  };
  return { d, rows, decisions, priceCalls };
}

describe("Bell report job", () => {
  it("reads the spot price 5 minutes after the open, stores the report and logs a plain-English line", async () => {
    const h = deps();
    expect(await runBellReportJob(h.d, new Date("2026-11-24T15:00:00Z"))).toEqual({ reported: ["h1"], waiting: [] });
    expect(h.priceCalls).toEqual(["NVDA@2026-11-24T14:35:00.000Z"]);
    expect(h.rows).toEqual([{ userId: "u1", sessionId: "s1", estGapUsd: "10", realGapUsd: "20", savedUsd: "-20.81", costUsd: "0.81", accuracyBp: "100" }]);
    expect(h.decisions[0]!.explanation).toBe(
      "Bell report: NVDA opened +2.0% vs estimate +1.0% (±2.3%). Hedge P&L −$20.00, costs $0.81, net saved −$20.81.",
    );
  });

  it("waits until the post-open price exists", async () => {
    const early = deps();
    expect(await runBellReportJob(early.d, new Date("2026-11-24T14:34:00Z"))).toEqual({ reported: [], waiting: ["h1"] });
    const noPrice = deps({ spotPriceAt: async () => null });
    expect(await runBellReportJob(noPrice.d, new Date("2026-11-24T15:00:00Z"))).toEqual({ reported: [], waiting: ["h1"] });
    expect(noPrice.rows).toEqual([]);
  });

  it("logs nothing when the report already exists, and survives a failing hedge", async () => {
    const dup = deps({ insertReport: async () => false });
    expect(await runBellReportJob(dup.d, new Date("2026-11-24T15:00:00Z"))).toEqual({ reported: [], waiting: [] });
    expect(dup.decisions).toEqual([]);
    const logs: string[] = [];
    const bad = deps({ snapshots: async () => Promise.reject(new Error("db down")), log: (e) => void logs.push(e) });
    expect(await runBellReportJob(bad.d, new Date("2026-11-24T15:00:00Z"))).toEqual({ reported: [], waiting: [] });
    expect(logs).toEqual(["bell_report_failed"]);
  });
});

describe("Bell report give-up", () => {
  const noSnap = () => deps({ snapshots: async () => [] });
  it("keeps waiting within 24 hours of the open", async () => {
    const h = noSnap();
    expect(await runBellReportJob(h.d, new Date("2026-11-25T14:00:00Z"))).toEqual({ reported: [], waiting: ["h1"] });
    expect(h.decisions).toEqual([]);
  });
  it("records bell_report_unavailable after 24 hours and stops waiting", async () => {
    const calls: string[] = [];
    const h = deps({ snapshots: async () => [], logDecision: async (_u, x) => void calls.push(x.action) });
    expect(await runBellReportJob(h.d, new Date("2026-11-25T14:31:00Z"))).toEqual({ reported: [], waiting: [] });
    expect(calls).toEqual(["bell_report_unavailable"]);
  });
});
