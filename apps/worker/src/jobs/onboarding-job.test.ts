import { describe, expect, it } from "vitest";
import { runOnboardingJob, type OnboardingJobDeps } from "./onboarding-job";

const rec = (id: string) => ({ tmUserId: `tm-${id}`, externalRefId: `glade_${id}`, solanaAddress: "S", evmAddress: "0x" });

function deps(over: Partial<OnboardingJobDeps> = {}) {
  const calls: string[] = [];
  let allowed = true;
  const d: OnboardingJobDeps = {
    pending: async () => [{ id: "a" }, { id: "b" }],
    ensureSigner: async (id) => void calls.push(`signer:${id}`),
    ensurePaper: async (id) => (calls.push(`paper:${id}`), true),
    createGateway: async (id) => (calls.push(`gateway:${id}`), rec(id)),
    gatewayAllowed: () => allowed,
    onGatewayRefused: () => {
      calls.push("backoff");
      allowed = false;
    },
    isGatewayRefusal: (e) => String(e).includes("user limit"),
    paperBudget: () => 10,
    record: async (id, ev) => void calls.push(`record:${id}:${ev}`),
    ...over,
  };
  return { d, calls };
}

describe("onboarding job (paper first)", () => {
  it("creates signer and paper account, then links the Gateway user", async () => {
    const { d, calls } = deps();
    expect(await runOnboardingJob(d)).toEqual({ ready: ["a", "b"], linked: ["a", "b"], failed: [] });
    expect(calls.slice(0, 5)).toEqual(["signer:a", "paper:a", "record:a:paper_ready", "gateway:a", "record:a:gateway_linked"]);
  });

  it("keeps paper onboarding going when True Markets refuses new users, and backs off", async () => {
    const { d, calls } = deps({
      createGateway: async () => {
        throw new Error("422 organization has reached its user limit");
      },
    });
    expect(await runOnboardingJob(d)).toEqual({ ready: ["a", "b"], linked: [], failed: [] });
    expect(calls.filter((c) => c === "backoff")).toHaveLength(1);
    expect(calls).not.toContain("gateway:b");
  });

  it("respects the daily paper budget", async () => {
    const { d, calls } = deps({ paperBudget: () => 0, gatewayAllowed: () => false });
    expect((await runOnboardingJob(d)).ready).toEqual([]);
    expect(calls.some((c) => c.startsWith("paper:"))).toBe(false);
  });

  it("isolates a failing user", async () => {
    const { d } = deps({
      ensureSigner: async (id) => {
        if (id === "a") throw new Error("db down");
      },
    });
    const r = await runOnboardingJob(d);
    expect(r.failed).toEqual(["a"]);
    expect(r.ready).toEqual(["b"]);
  });
});

describe("onboarding failure backoff", () => {
  it("skips a failed user until the backoff ends and asks the query to exclude them", async () => {
    let t = 0;
    const failedAt = new Map<string, number>();
    const asked: string[][] = [];
    const { d } = deps({
      pending: async (_l, _g, ex) => (asked.push(ex), [{ id: "bad" }].filter((x) => !ex.includes(x.id))),
      ensureSigner: async () => {
        throw new Error("duplicate key");
      },
      failedAt,
      now: () => t,
      backoffMs: 1000,
    });
    expect((await runOnboardingJob(d)).failed).toEqual(["bad"]);
    t = 500;
    expect((await runOnboardingJob(d)).failed).toEqual([]);
    expect(asked[1]).toEqual(["bad"]);
    t = 1500;
    expect((await runOnboardingJob(d)).failed).toEqual(["bad"]);
  });
});
