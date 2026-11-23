import { generateSignerKeyPair } from "@glade/stamp";
import { createTmClient, TokenManager } from "@glade/tm-client";
import { describe, expect, it } from "vitest";
import { createExecutor } from "./executor";
import { memoryRepo } from "./memory-repo";
import type { ExecIntent, ExecutorConfig } from "./types";

const signer = generateSignerKeyPair();
const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = `${enc({})}.${enc({ tm: { organization_id: "org" } })}.x`;
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Route = (body: unknown) => Response;

function harness(routes: Record<string, Route>, config: Partial<ExecutorConfig> = {}) {
  const calls: { key: string; body: unknown; onBehalfOf: string | null }[] = [];
  const fetchFn = (async (input: Request) => {
    const url = new URL(input.url);
    const key = `${input.method} ${url.pathname.replace("/v1/gateway", "")}`;
    const text = input.method === "GET" ? "" : await input.text();
    const body = text ? JSON.parse(text) : undefined;
    calls.push({ key, body, onBehalfOf: input.headers.get("TM-On-Behalf-Of") });
    const r = routes[key];
    return r ? r(body) : json(404, { type: "not_found", message: key, request_id: "x" });
  }) as typeof fetch;
  const tokens = new TokenManager(async () => ({ accessToken: jwt, expiresAt: Infinity, claims: { organizationId: "org", role: undefined } }));
  const tm = createTmClient({ restBase: "https://tm.test", tokens, fetch: fetchFn, sleep: async () => {} });
  const mem = memoryRepo();
  let t = 0;
  const authorizeCalls: string[] = [];
  let allow = true;
  const exec = createExecutor(tm, {
    repo: mem.repo,
    authorize: async (i) => (authorizeCalls.push(i.id), allow ? { ok: true } : { ok: false, reasons: ["no active mandate"] }),
    signerFor: async () => signer,
    config: { tmEnv: "uat", allowProd: false, maxOrderUsd: "20", pollIntervalMs: 2000, pollTimeoutMs: 10_000, ...config },
    now: () => t,
    sleep: async (ms) => void (t += ms),
  });
  return { exec, calls, mem, authorizeCalls, deny: () => (allow = false), count: (k: string) => calls.filter((c) => c.key === k).length };
}

const intent: ExecIntent = {
  id: "i1",
  userId: "app-u1",
  tmUserId: "tm-u1",
  assetId: "perp-sp500",
  side: "sell",
  qty: "0.002",
  qtyUnit: "base",
  leverage: 2,
  reduceOnly: false,
  notionalUsd: "12",
  venue: "defi",
};

const created = (id = "o1", payloads = [{ digest: "d", payload: "tx-bytes\n" }]) => () => json(201, { order_id: id, status: "initialized", payloads });
const complete = () => json(200, { order_id: "o1", status: "complete", executed_qty: "0.002", executed_vwap: "6000", fee: "0.01", explorer_url: "https://explorer/x" });

describe("Executor", () => {
  it("creates, stamps exactly the returned payloads, executes and records the fill", async () => {
    const h = harness({ "POST /orders": created(), "POST /orders/o1/execute": () => json(200, { status: "pending" }), "GET /orders/o1": complete });
    const r = await h.exec.execute(intent);
    expect(r.outcome).toBe("complete");
    const exe = h.calls.find((c) => c.key === "POST /orders/o1/execute")!;
    const sigs = (exe.body as { signatures: string[]; auth_type: string });
    expect(sigs.auth_type).toBe("api_key");
    expect(sigs.signatures).toHaveLength(1);
    const env = JSON.parse(Buffer.from(sigs.signatures[0]!, "base64url").toString());
    expect(env.scheme).toBe("SIGNATURE_SCHEME_TK_API_P256");
    expect(h.calls.every((c) => c.onBehalfOf === "tm-u1")).toBe(true);
    expect(h.mem.intents.get("i1")).toBe("done");
    expect([...h.mem.orders.values()][0]).toMatchObject({ status: "complete", explorerUrl: "https://explorer/x", fee: "0.01" });
    const order = h.calls.find((c) => c.key === "POST /orders")!.body as Record<string, unknown>;
    expect(order).toMatchObject({ side: "sell", type: "market", leverage: 2, venue: "defi" });
    expect(order).not.toHaveProperty("reduce_only");
  });

  it("treats 201 with an empty order_id as no order and reports quote issues", async () => {
    const h = harness({ "POST /orders": () => json(201, { order_id: "", quote: { issues: ["insufficient_balance"] } }) });
    const r = await h.exec.execute(intent);
    expect(r).toMatchObject({ outcome: "failed" });
    expect((r as { reason: string }).reason).toContain("insufficient_balance");
    expect(h.count("POST /orders/o1/execute")).toBe(0);
  });

  it("polls without signing when payloads are empty", async () => {
    const h = harness({ "POST /orders": created("o1", []), "GET /orders/o1": complete });
    expect((await h.exec.execute(intent)).outcome).toBe("complete");
    expect(h.count("POST /orders/o1/execute")).toBe(0);
  });

  it("recreates the order once after 422 quote_stale", async () => {
    let n = 0;
    const h = harness({
      "POST /orders": () => json(201, { order_id: ++n === 1 ? "o1" : "o2", payloads: [{ digest: "d", payload: "p\n" }] }),
      "POST /orders/o1/execute": () => json(422, { type: "failed_precondition", code: "quote_stale", message: "stale", request_id: "r" }),
      "POST /orders/o2/execute": () => json(200, {}),
      "GET /orders/o2": () => json(200, { status: "complete" }),
    });
    expect((await h.exec.execute(intent)).outcome).toBe("complete");
    expect(h.count("POST /orders")).toBe(2);
    expect([...h.mem.orders.values()].map((o) => [o.attempt, o.status])).toEqual([[1, "failed"], [2, "complete"]]);
  });

  it("gives up after a second quote_stale", async () => {
    let n = 0;
    const h = harness({
      "POST /orders": () => json(201, { order_id: `o${++n}`, payloads: [{ digest: "d", payload: "p\n" }] }),
      "POST /orders/o1/execute": () => json(422, { type: "failed_precondition", code: "quote_stale", message: "", request_id: "r" }),
      "POST /orders/o2/execute": () => json(422, { type: "failed_precondition", code: "quote_stale", message: "", request_id: "r" }),
    });
    expect(await h.exec.execute(intent)).toMatchObject({ outcome: "failed", reason: "quote stale after retry" });
    expect(h.count("POST /orders")).toBe(2);
  });

  it("polls on 409 already_submitted and never re-executes", async () => {
    const h = harness({
      "POST /orders": created(),
      "POST /orders/o1/execute": () => json(409, { type: "conflict", code: "already_submitted", message: "", request_id: "r" }),
      "GET /orders/o1": complete,
    });
    expect((await h.exec.execute(intent)).outcome).toBe("complete");
    expect(h.count("POST /orders/o1/execute")).toBe(1);
  });

  it("resumes after a crash mid-flow by polling, without creating or executing again", async () => {
    const h = harness({ "GET /orders/o1": complete });
    await h.mem.repo.insertOrder({ intentId: "i1", attempt: 1, tmOrderId: "o1", status: "signed" });
    expect((await h.exec.execute(intent)).outcome).toBe("complete");
    expect(h.count("POST /orders")).toBe(0);
    expect(h.count("POST /orders/o1/execute")).toBe(0);
  });

  it("is idempotent once complete", async () => {
    const h = harness({ "POST /orders": created(), "POST /orders/o1/execute": () => json(200, {}), "GET /orders/o1": complete });
    await h.exec.execute(intent);
    const before = h.calls.length;
    expect((await h.exec.execute(intent)).outcome).toBe("complete");
    expect(h.calls.length).toBe(before);
  });

  it("hands an unresolved order to the reconciler after the poll timeout", async () => {
    const h = harness({ "POST /orders": created(), "POST /orders/o1/execute": () => json(200, {}), "GET /orders/o1": () => json(200, { status: "pending" }) });
    expect(await h.exec.execute(intent)).toEqual({ outcome: "unknown", tmOrderId: "o1" });
    expect([...h.mem.orders.values()][0]!.status).toBe("unknown");
  });

  it("refuses to sign when the policy check fails", async () => {
    const h = harness({ "POST /orders": created() });
    h.deny();
    expect(await h.exec.execute(intent)).toEqual({ outcome: "rejected", reasons: ["no active mandate"] });
    expect(h.calls).toHaveLength(0);
  });

  it("re-checks policy right before stamping", async () => {
    const h = harness({ "POST /orders": created() });
    const exec = h.exec;
    let calls = 0;
    // Allow the first check, deny the second (e.g. kill switch flipped mid-flow).
    h.authorizeCalls.length = 0;
    const origPush = h.authorizeCalls.push.bind(h.authorizeCalls);
    h.authorizeCalls.push = (...a: string[]) => (++calls === 2 && h.deny(), origPush(...a));
    expect(await exec.execute(intent)).toMatchObject({ outcome: "rejected" });
    expect(h.count("POST /orders/o1/execute")).toBe(0);
  });

  describe("production guard", () => {
    it("blocks prod orders unless ALLOW_PROD is set", async () => {
      const h = harness({ "POST /orders": created() }, { tmEnv: "prod", allowProd: false });
      const r = await h.exec.execute(intent);
      expect(r.outcome).toBe("rejected");
      expect(h.calls).toHaveLength(0);
    });
    it("blocks prod orders above MAX_ORDER_USD even with ALLOW_PROD", async () => {
      const h = harness({ "POST /orders": created() }, { tmEnv: "prod", allowProd: true, maxOrderUsd: "10" });
      expect(await h.exec.execute(intent)).toMatchObject({ outcome: "rejected" });
      expect(h.calls).toHaveLength(0);
    });
    it("allows a small prod order with ALLOW_PROD", async () => {
      const h = harness(
        { "POST /orders": created(), "POST /orders/o1/execute": () => json(200, {}), "GET /orders/o1": complete },
        { tmEnv: "prod", allowProd: true, maxOrderUsd: "20" },
      );
      expect((await h.exec.execute(intent)).outcome).toBe("complete");
    });
  });
});
