import { randomBytes } from "node:crypto";
import { createTmClient, TokenManager } from "@glade/tm-client";
import { describe, expect, it } from "vitest";
import { loadSigner, memoryOnboardingRepo, onboardUser } from "./onboard";

const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = `${enc({})}.${enc({ tm: { organization_id: "org1" } })}.x`;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function harness(handler: (body: { external_ref_id: string; signer_public_key: string }, n: number) => Response) {
  const bodies: { external_ref_id: string; signer_public_key: string }[] = [];
  const fetchFn = (async (req: Request) => {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/v1/account/organizations/org1/users") {
      const b = JSON.parse(await req.text());
      bodies.push(b);
      return handler(b, bodies.length);
    }
    return json(404, { type: "not_found", message: url.pathname, request_id: "x" });
  }) as typeof fetch;
  const tokens = new TokenManager(async () => ({ accessToken: jwt, expiresAt: Infinity, claims: { organizationId: "org1", role: undefined } }));
  const tm = createTmClient({ restBase: "https://tm.test", tokens, fetch: fetchFn, sleep: async () => {} });
  return { tm, bodies, repo: memoryOnboardingRepo(), masterKey: randomBytes(32) };
}

const wallets = [{ chain_family: "solana", address: "So1anaAddr" }, { chain_family: "evm", address: "0xabc" }];

describe("onboardUser", () => {
  it("creates a sealed signer key and a Gateway user with wallets", async () => {
    const h = harness(() => json(200, { user_id: "tm-1", wallets }));
    const rec = await onboardUser({ tm: h.tm, repo: h.repo, masterKey: h.masterKey, env: "prod" }, "u1");
    expect(rec).toEqual({ tmUserId: "tm-1", externalRefId: "glade_u1", solanaAddress: "So1anaAddr", evmAddress: "0xabc" });
    const stored = h.repo.signers.get("u1")!;
    expect(h.bodies[0]!.signer_public_key).toBe(stored.publicKeyHex);
    expect(JSON.stringify(stored.sealed)).not.toContain((await loadSigner(h.repo, h.masterKey, "u1")).privateKeyHex);
  });

  it("is a no-op once onboarded", async () => {
    const h = harness(() => json(200, { user_id: "tm-1", wallets }));
    const deps = { tm: h.tm, repo: h.repo, masterKey: h.masterKey, env: "prod" as const };
    await onboardUser(deps, "u1");
    await onboardUser(deps, "u1");
    expect(h.bodies).toHaveLength(1);
  });

  it("reuses the same signer key after a failed creation", async () => {
    const h = harness((_b, n) => (n === 1 ? json(500, { type: "internal", message: "boom", request_id: "r" }) : json(200, { user_id: "tm-1", wallets })));
    const deps = { tm: h.tm, repo: h.repo, masterKey: h.masterKey, env: "prod" as const };
    await expect(onboardUser(deps, "u1")).rejects.toThrow();
    await onboardUser(deps, "u1");
    expect(h.bodies[0]!.signer_public_key).toBe(h.bodies[1]!.signer_public_key);
  });

  it("retries the identical request on 503 until wallets exist", async () => {
    const h = harness((_b, n) => (n < 3 ? json(503, { type: "unavailable", message: "wallets", request_id: "r" }) : json(200, { user_id: "tm-1", wallets })));
    await onboardUser({ tm: h.tm, repo: h.repo, masterKey: h.masterKey, env: "prod" }, "u1");
    expect(new Set(h.bodies.map((b) => JSON.stringify(b))).size).toBe(1);
  });

  it("re-fetches a stored user that has no wallet addresses", async () => {
    const h = harness(() => json(200, { user_id: "tm-1", wallets }));
    const deps = { tm: h.tm, repo: h.repo, masterKey: h.masterKey, env: "prod" as const };
    await h.repo.saveTmUser("u1", "prod", { tmUserId: "tm-1", externalRefId: "glade_u1", solanaAddress: null, evmAddress: null });
    const rec = await onboardUser(deps, "u1");
    expect(rec.solanaAddress).toBe("So1anaAddr");
  });

  it("will not decrypt with the wrong master key", async () => {
    const h = harness(() => json(200, { user_id: "tm-1", wallets }));
    await onboardUser({ tm: h.tm, repo: h.repo, masterKey: h.masterKey, env: "prod" }, "u1");
    await expect(loadSigner(h.repo, randomBytes(32), "u1")).rejects.toThrow();
  });
});
