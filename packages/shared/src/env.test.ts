import { describe, expect, it } from "vitest";
import { loadEnv } from "./env";

const valid = {
  TM_ENV: "uat",
  TM_ORG_KEY_FILE: "./secrets/org-key.json",
  MAX_ORDER_USD: "20",
  SIGNER_MASTER_KEY: `base64:${Buffer.alloc(32, 7).toString("base64")}`,
  DATABASE_URL: "postgres://u:p@h:5432/db",
  APP_ORIGIN: "http://localhost:3000",
  WEBAUTHN_RP_ID: "localhost",
  SESSION_SECRET: "x".repeat(32),
};

describe("loadEnv", () => {
  it("parses a valid env and applies defaults", () => {
    const e = loadEnv(valid);
    expect(e.FLOOR_COOLDOWN_SEC).toBe(600);
    expect(e.GLADE_PAUSE_ALL).toBe(false);
  });
  it("rejects a short master key without leaking its value", () => {
    const secret = Buffer.alloc(16, 9).toString("base64");
    const run = () => loadEnv({ ...valid, SIGNER_MASTER_KEY: `base64:${secret}` });
    expect(run).toThrow(/SIGNER_MASTER_KEY/);
    try {
      run();
    } catch (e) {
      expect(String(e)).not.toContain(secret);
    }
  });
});
