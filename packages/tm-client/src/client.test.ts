import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createTmClient } from "./client";
import { TmApiError } from "./errors";
import { fakeJwt, fakeServer, json } from "./fake.test-helpers";
import { apiKeyMinter, TokenManager, type OrgKey } from "./token";

const BASE = "https://tm.test";
const ORG = "org_123";
const key: OrgKey = {
  key_id: "key_1",
  private_key: generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "jwk" }),
};

function setup(routes: Parameters<typeof fakeServer>[0], clock = { t: Date.parse("2026-11-24T10:00:00Z") }) {
  let mints = 0;
  const server = fakeServer({
    "POST /v1/auth/api-key/token": () => {
      mints++;
      return json(200, {
        access_token: fakeJwt({ tm: { organization_id: ORG }, n: mints }),
        token_type: "Bearer",
        expires_in: new Date(clock.t + 3600_000).toISOString(),
      });
    },
    ...routes,
  });
  const now = () => clock.t;
  const sleeps: number[] = [];
  const tokens = new TokenManager(apiKeyMinter({ restBase: BASE, key, fetch: server.fetch, now }), now);
  const client = createTmClient({
    restBase: BASE,
    tokens,
    fetch: server.fetch,
    now,
    sleep: async (ms) => void sleeps.push(ms),
  });
  return { client, server, tokens, clock, sleeps, mints: () => mints };
}

describe("TokenManager", () => {
  it("caches the token and re-mints after 55 minutes", async () => {
    const t = setup({});
    await t.tokens.get();
    await t.tokens.get();
    expect(t.mints()).toBe(1);
    t.clock.t += 54 * 60_000;
    await t.tokens.get();
    expect(t.mints()).toBe(1);
    t.clock.t += 2 * 60_000;
    await t.tokens.get();
    expect(t.mints()).toBe(2);
  });

  it("shares one mint between concurrent callers", async () => {
    const t = setup({});
    await Promise.all([t.tokens.get(), t.tokens.get(), t.tokens.get()]);
    expect(t.mints()).toBe(1);
  });

  it("signs the challenge with key_id and a unix-seconds timestamp", async () => {
    const t = setup({});
    await t.tokens.get();
    const body = JSON.parse(t.server.calls[0]!.body);
    expect(body.key_id).toBe("key_1");
    expect(body.timestamp).toBe(Math.floor(t.clock.t / 1000));
    expect(Buffer.from(body.signature, "base64url")).toHaveLength(64);
  });

  it("explains a non-organization key", async () => {
    const server = fakeServer({
      "POST /v1/auth/api-key/token": () =>
        json(200, { access_token: fakeJwt({ role: "viewer" }), refresh_token: "r", expires_in: "2026-11-24T11:00:00Z" }),
    });
    const tokens = new TokenManager(apiKeyMinter({ restBase: BASE, key, fetch: server.fetch }));
    await expect(tokens.organizationId()).rejects.toThrow(/not an organization key/);
  });
});

describe("http behaviour", () => {
  it("re-mints once on 401 and retries", async () => {
    let n = 0;
    const t = setup({ "GET /v1/gateway/positions": () => (++n === 1 ? json(401, { type: "unauthenticated", message: "expired", request_id: "r1" }) : json(200, { positions: [] })) });
    await expect(t.client.forUser("u1").positions()).resolves.toEqual({ positions: [] });
    expect(t.mints()).toBe(2);
  });

  it("does not loop on repeated 401", async () => {
    const t = setup({ "GET /v1/gateway/positions": () => json(401, { type: "unauthenticated", message: "no", request_id: "r2" }) });
    await expect(t.client.forUser("u1").positions()).rejects.toMatchObject({ status: 401, requestId: "r2" });
    expect(t.mints()).toBe(2);
  });

  it("waits X-RateLimit-Reset on 429, then succeeds", async () => {
    let n = 0;
    const t = setup({
      "GET /v1/gateway/positions": () =>
        ++n === 1 ? json(429, { type: "resource_exhausted", message: "slow", request_id: "r3" }, { "x-ratelimit-reset": "7" }) : json(200, { positions: [] }),
    });
    await t.client.forUser("u1").positions();
    expect(t.sleeps).toEqual([7000]);
  });

  it("gives up after the 429 retry budget", async () => {
    const t = setup({ "GET /v1/gateway/positions": () => json(429, { type: "resource_exhausted", message: "slow", request_id: "r4" }, { "x-ratelimit-reset": "1" }) });
    await expect(t.client.forUser("u1").positions()).rejects.toBeInstanceOf(TmApiError);
    expect(t.sleeps).toHaveLength(3);
  });
});

describe("TM-On-Behalf-Of", () => {
  it("is sent on user routes and not on org routes", async () => {
    const t = setup({
      "GET /v1/gateway/portfolio": () => json(200, { total_usd: "10", cash_usd: "10", balances: [], positions: [] }),
      "POST /v1/account/organizations/org_123/users": () => json(200, { user_id: "u9", wallets: [{ chain_family: "solana", address: "So1" }] }),
    });
    await t.client.forUser("u1").portfolio();
    await t.client.createUser({ external_ref_id: "glade_x", signer_public_key: "02ab" });
    const user = t.server.calls.find((c) => c.path === "/v1/gateway/portfolio")!;
    const org = t.server.calls.find((c) => c.path.endsWith("/users"))!;
    expect(user.headers.get("TM-On-Behalf-Of")).toBe("u1");
    expect(org.headers.get("TM-On-Behalf-Of")).toBeNull();
    expect(user.headers.get("Authorization")).toMatch(/^Bearer /);
  });
});

describe("createUser", () => {
  it("repeats the same request on 503 until wallets are ready", async () => {
    let n = 0;
    const t = setup({
      "POST /v1/account/organizations/org_123/users": () =>
        ++n < 3 ? json(503, { type: "unavailable", message: "wallets", request_id: "r5" }) : json(200, { user_id: "u9", wallets: [{ chain_family: "solana", address: "So1" }] }),
    });
    const u = await t.client.createUser({ external_ref_id: "glade_x", signer_public_key: "02ab" });
    expect(u.user_id).toBe("u9");
    const bodies = t.server.calls.filter((c) => c.path.endsWith("/users")).map((c) => c.body);
    expect(new Set(bodies).size).toBe(1);
    expect(t.sleeps).toEqual([2000, 2000]);
  });
});

describe("errors and validation", () => {
  it("maps quote_stale and already_submitted", async () => {
    const t = setup({
      "POST /v1/gateway/orders/o1/execute": () => json(422, { type: "failed_precondition", code: "quote_stale", message: "stale", request_id: "r6" }),
      "POST /v1/gateway/orders/o2/execute": () => json(409, { type: "conflict", code: "already_submitted", message: "dup", request_id: "r7" }),
    });
    const u = t.client.forUser("u1");
    const e1 = await u.executeOrder("o1", ["s"]).catch((e) => e);
    const e2 = await u.executeOrder("o2", ["s"]).catch((e) => e);
    expect(e1.isQuoteStale).toBe(true);
    expect(e2.isAlreadySubmitted).toBe(true);
    expect(String(e1.message)).toContain("request_id=r6");
  });

  it("rejects malformed money fields at the boundary", async () => {
    const t = setup({ "GET /v1/gateway/positions": () => json(200, { positions: [{ size: 1.5 }] }) });
    await expect(t.client.forUser("u1").positions()).rejects.toThrow();
  });

  it("keeps an empty order_id visible so callers can read quote.issues", async () => {
    const t = setup({
      "POST /v1/gateway/orders": () => json(201, { order_id: "", quote: { issues: ["insufficient_balance"] } }),
    });
    const r = await t.client.forUser("u1").createOrder({ asset_id: "a", side: "sell", type: "market", qty: "1", qty_unit: "base", venue: "defi" });
    expect(r.order_id).toBe("");
    expect(r.quote?.issues).toEqual(["insufficient_balance"]);
  });
});

describe("public reads", () => {
  it("lists assets across pages without a token", async () => {
    let page = 0;
    const server = fakeServer({
      "GET /v1/gateway/assets": (_r, url) => {
        page++;
        expect(url.searchParams.get("product_type")).toBe("perp");
        return page === 1
          ? json(200, { data: [{ id: "p1", symbol: "NVDA", type: "perp", order_types: ["market"] }], pagination: { next_cursor: "c2" } })
          : json(200, { data: [{ id: "p2", symbol: "SP500", type: "perp", order_types: ["market"] }], pagination: {} });
      },
    });
    const client = createTmClient({ restBase: BASE, fetch: server.fetch });
    const assets = await client.listAssets({ product_type: "perp" });
    expect(assets.map((a) => a.symbol)).toEqual(["NVDA", "SP500"]);
    expect(server.calls.every((c) => !c.headers.get("Authorization"))).toBe(true);
    expect(() => client.forUser("u1")).toThrow(/org token/);
  });
});

describe("availability", () => {
  it("parses the caller country and allowlists", async () => {
    const t = setup({
      "GET /v1/gateway/assets/availability": () => json(200, { country: "PT", allowed_product_types: ["spot", "perp"], allowed_asset_classes: ["crypto", "stock"] }),
    });
    const a = await t.client.availability();
    expect(a.allowed_product_types).toContain("perp");
    expect(t.server.calls.at(-1)!.headers.get("TM-On-Behalf-Of")).toBeNull();
  });
});
