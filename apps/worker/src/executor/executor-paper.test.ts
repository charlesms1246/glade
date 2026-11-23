import { createPaperVenue, memoryPaperRepo, type PaperAsset } from "@glade/paper";
import { dec } from "@glade/shared";
import { generateSignerKeyPair } from "@glade/stamp";
import { describe, expect, it } from "vitest";
import { createExecutor } from "./executor";
import { memoryRepo } from "./memory-repo";
import type { ExecIntent, ExecutorConfig, ExecVenue } from "./types";

const perp: PaperAsset = { assetId: "perp-nvda", symbol: "NVDA", type: "perp", assetClass: "stock", maxLeverage: 5, economicAssetId: null, venue: "hyperliquid", chain: "hypercore-perp" };

function harness(config: Partial<ExecutorConfig> = {}) {
  const signer = generateSignerKeyPair();
  const paper = memoryPaperRepo({ "app-u1": signer.publicKeyHex });
  let t = 1_000_000;
  let price = "100";
  const venue = createPaperVenue({
    repo: paper.repo,
    prices: async () => dec(price),
    registry: async (id) => (id === perp.assetId ? perp : null),
    now: () => t,
  });
  const mem = memoryRepo();
  const withVenue = (v: ExecVenue) =>
    createExecutor(v, {
      repo: mem.repo,
      authorize: async () => ({ ok: true }),
      signerFor: async () => signer,
      config: { venue: "paper", tmEnv: "uat", maxOrderUsd: "200", pollIntervalMs: 1000, pollTimeoutMs: 5000, ...config },
      now: () => t,
      sleep: async (ms) => void (t += ms),
    });
  return {
    now: () => t,
    exec: withVenue(venue),
    withVenue,
    venue,
    paper,
    mem,
    user: venue.forUser("app-u1"),
    setPrice: (p: string) => (price = p),
    tick: (ms: number) => (t += ms),
  };
}

const open: ExecIntent = {
  id: "i-open",
  userId: "app-u1",
  venueUserId: "app-u1",
  assetId: perp.assetId,
  side: "sell",
  qty: "1",
  qtyUnit: "base",
  leverage: 2,
  reduceOnly: false,
  notionalUsd: "100",
  venue: "defi",
};
const closeAll: ExecIntent = { ...open, id: "i-close", side: "buy", leverage: null, reduceOnly: true };

describe("Executor on the paper venue (real stamps, verified by the venue)", () => {
  it("opens a short, then closes it reduce-only", async () => {
    const h = harness();
    await h.venue.fundPaper("app-u1", "1000");
    const r = await h.exec.execute(open);
    expect(r).toMatchObject({ outcome: "complete", row: { executedQty: "1", avgPrice: "100", fee: "0.045" } });
    expect((await h.user.positions()).positions[0]).toMatchObject({ side: "short", size: "1", leverage: 2 });

    h.setPrice("90");
    expect((await h.exec.execute(closeAll)).outcome).toBe("complete");
    const p = await h.user.portfolio();
    expect(p.positions).toEqual([]);
    // 1000 − 50 margin − 0.045 fee + 50 released + 10 pnl − 0.0405 fee
    expect(p.cash_usd).toBe("1009.9145");
    expect(h.mem.intents.get("i-close")).toBe("done");
  });

  it("recreates the order once when the paper quote goes stale before execute", async () => {
    const h = harness();
    await h.venue.fundPaper("app-u1", "1000");
    let aged = false;
    // The first quote ages past 120 s between create and execute.
    const exec = h.withVenue({
      kind: "paper",
      forUser: (id) => {
        const u = h.venue.forUser(id);
        return {
          ...u,
          createOrder: async (b) => {
            const res = await u.createOrder(b);
            if (!aged) {
              aged = true;
              h.tick(120_001);
            }
            return res;
          },
        };
      },
    });
    expect((await exec.execute(open)).outcome).toBe("complete");
    expect([...h.mem.orders.values()].map((o) => [o.attempt, o.status])).toEqual([[1, "failed"], [2, "complete"]]);
    expect([...h.paper.orders.values()].map((o) => o.failureReason ?? o.status).sort()).toEqual(["complete", "quote_stale"]);
    expect((await h.user.positions()).positions[0]!.size).toBe("1");
  });

  it("polls instead of re-executing after 409 already_submitted, and fills once", async () => {
    const h = harness();
    await h.venue.fundPaper("app-u1", "1000");
    // A lost response: the venue filled, then the repeated call gets 409.
    const exec = h.withVenue({
      kind: "paper",
      forUser: (id) => {
        const u = h.venue.forUser(id);
        return {
          ...u,
          executeOrder: async (oid, sigs) => {
            await u.executeOrder(oid, sigs);
            return u.executeOrder(oid, sigs);
          },
        };
      },
    });
    expect((await exec.execute(open)).outcome).toBe("complete");
    expect((await h.user.positions()).positions[0]!.size).toBe("1");
    expect(h.paper.ledger.filter((l) => l.kind === "perp_margin")).toHaveLength(1);
  });

  it("fails with insufficient_balance and creates no order", async () => {
    const h = harness();
    await h.venue.fundPaper("app-u1", "10");
    const r = await h.exec.execute(open);
    expect(r).toMatchObject({ outcome: "failed" });
    expect((r as { reason: string }).reason).toContain("insufficient_balance");
    expect(h.paper.orders.size).toBe(0);
    expect([...h.mem.orders.values()][0]!.status).toBe("failed_funding");
  });

  it("lets the paper venue run with TM_ENV=prod, since nothing reaches True Markets", async () => {
    const h = harness({ tmEnv: "prod" });
    await h.venue.fundPaper("app-u1", "1000");
    expect((await h.exec.execute(open)).outcome).toBe("complete");
  });

  it("rejects the paper venue when config says uat, and still enforces MAX_ORDER_USD", async () => {
    expect(await harness({ venue: "uat" }).exec.execute(open)).toEqual({ outcome: "rejected", reasons: ["the paper venue requires config venue=paper"] });
    expect(await harness({ maxOrderUsd: "50" }).exec.execute(open)).toMatchObject({ outcome: "rejected" });
  });

  describe("orders created but never executed", () => {
    // executeOrder fails before reaching the venue (network drop, or a crash right after "signed").
    const dropFirstExecutes = (h: ReturnType<typeof harness>, n: number) => {
      let left = n;
      return h.withVenue({
        kind: "paper",
        forUser: (id) => {
          const u = h.venue.forUser(id);
          return {
            ...u,
            executeOrder: async (oid, sigs) => {
              if (left-- > 0) throw new Error("socket hang up");
              return u.executeOrder(oid, sigs);
            },
          };
        },
      });
    };

    it("crash after signed: retires the initialized order once its quote expires, then recreates once", async () => {
      const h = harness();
      await h.venue.fundPaper("app-u1", "1000");
      expect((await dropFirstExecutes(h, 1).execute(open)).outcome).toBe("complete");
      expect([...h.mem.orders.values()].map((o) => [o.attempt, o.status, (o.raw as { reason?: string }).reason ?? null])).toEqual([
        [1, "failed", "never executed"],
        [2, "complete", null],
      ]);
      expect([...h.paper.orders.values()].map((o) => o.status)).toEqual(["canceled", "complete"]);
      expect(h.mem.intents.get("i-open")).toBe("done");
      expect((await h.user.positions()).positions[0]!.size).toBe("1");
    });

    it("poll timeout on an initialized order fails the intent cleanly instead of leaving it executing", async () => {
      const h = harness();
      await h.venue.fundPaper("app-u1", "1000");
      expect(await dropFirstExecutes(h, 99).execute(open)).toEqual({ outcome: "failed", reason: "order was never executed" });
      expect([...h.mem.orders.values()].map((o) => o.status)).toEqual(["failed", "failed"]);
      expect(h.mem.intents.get("i-open")).toBe("failed");
      expect([...h.paper.orders.values()].map((o) => o.status)).toEqual(["canceled", "canceled"]);
      expect((await h.user.positions()).positions).toEqual([]);
    });

    it("resume of a signed attempt whose venue order is still initialized recreates it", async () => {
      const h = harness();
      await h.venue.fundPaper("app-u1", "1000");
      const o = await h.user.createOrder({ asset_id: perp.assetId, side: "sell", type: "market", qty: "1", qty_unit: "base", leverage: 2, venue: "defi" });
      await h.mem.repo.insertOrder({ intentId: "i-open", attempt: 1, tmOrderId: o.order_id!, status: "signed" });
      h.tick(130_000);
      expect((await h.exec.execute(open)).outcome).toBe("complete");
      expect([...h.mem.orders.values()].map((r) => [r.attempt, r.status])).toEqual([[1, "failed"], [2, "complete"]]);
      expect(h.paper.orders.get(o.order_id!)!.status).toBe("canceled");
    });

    it("uses the row's creation time when known, so a stale order is retired without waiting", async () => {
      const h = harness();
      await h.venue.fundPaper("app-u1", "1000");
      const o = await h.user.createOrder({ asset_id: perp.assetId, side: "sell", type: "market", qty: "1", qty_unit: "base", leverage: 2, venue: "defi" });
      h.tick(130_000);
      await h.mem.repo.insertOrder({ intentId: "i-open", attempt: 1, tmOrderId: o.order_id!, status: "unknown", createdAtMs: h.now() - 130_000 });
      const before = h.now();
      expect((await h.exec.execute(open)).outcome).toBe("complete");
      expect(h.now() - before).toBeLessThan(5_000);
    });

    it("after a crash right after retiring an order, recreates exactly once", async () => {
      const h = harness();
      await h.venue.fundPaper("app-u1", "1000");
      await h.mem.repo.insertOrder({ intentId: "i-open", attempt: 1, tmOrderId: "gone", status: "failed", raw: { reason: "never executed" } });
      expect((await dropFirstExecutes(h, 99).execute(open)).outcome).toBe("failed");
      expect([...h.mem.orders.values()].map((o) => o.attempt)).toEqual([1, 2]);
    });

    it("recreates at most once in total: a second never-executed attempt fails the intent", async () => {
      const h = harness();
      await h.venue.fundPaper("app-u1", "1000");
      await h.mem.repo.insertOrder({ intentId: "i-open", attempt: 1, tmOrderId: "gone", status: "failed", raw: { reason: "never executed" } });
      const o = await h.user.createOrder({ asset_id: perp.assetId, side: "sell", type: "market", qty: "1", qty_unit: "base", leverage: 2, venue: "defi" });
      await h.mem.repo.insertOrder({ intentId: "i-open", attempt: 2, tmOrderId: o.order_id!, status: "signed" });
      expect(await h.exec.execute(open)).toEqual({ outcome: "failed", reason: "order was never executed" });
      expect(h.mem.orders.size).toBe(2);
      expect(h.paper.orders.size).toBe(1);
    });
  });
});
