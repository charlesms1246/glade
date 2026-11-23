import { describe, expect, it } from "vitest";
import { runOnboardingJob } from "./onboarding-job";

const rec = (id: string) => ({ tmUserId: `tm-${id}`, externalRefId: `glade_${id}`, solanaAddress: "S", evmAddress: "0x" });

describe("onboarding job", () => {
  it("onboards, funds paper and records each pending user", async () => {
    const calls: string[] = [];
    const r = await runOnboardingJob({
      pending: async () => [{ id: "a" }, { id: "b" }],
      onboard: async (id) => (calls.push(`onboard:${id}`), rec(id)),
      fundPaper: async (id) => void calls.push(`fund:${id}`),
      record: async (id) => void calls.push(`record:${id}`),
    });
    expect(r).toEqual({ done: ["a", "b"], failed: [] });
    expect(calls).toEqual(["onboard:a", "fund:a", "record:a", "onboard:b", "fund:b", "record:b"]);
  });

  it("keeps going when one user fails and does not fund a failed onboarding", async () => {
    const funded: string[] = [];
    const r = await runOnboardingJob({
      pending: async () => [{ id: "bad" }, { id: "ok" }],
      onboard: async (id) => {
        if (id === "bad") throw new Error("503");
        return rec(id);
      },
      fundPaper: async (id) => void funded.push(id),
      record: async () => {},
    });
    expect(r).toEqual({ done: ["ok"], failed: ["bad"] });
    expect(funded).toEqual(["ok"]);
  });
});
