import { describe, expect, it } from "vitest";
import { macWith, sealWith, unsealWith } from "./seal-core";

const S = "x".repeat(32);
const NOW = 1_800_000_000_000;

describe("sealed tokens", () => {
  it("round-trips for the same kind", () => {
    const t = sealWith(S, "session", { uid: "u1" }, 60, NOW);
    expect(unsealWith<{ uid: string }>(S, "session", t, NOW)?.uid).toBe("u1");
  });

  it("never unseals a challenge cookie as a session", () => {
    const t = sealWith(S, "wa", { uid: "u1", challenge: "c" }, 60, NOW);
    expect(unsealWith(S, "session", t, NOW)).toBeNull();
  });

  it("rejects expired, tampered, wrong-key and untyped tokens", () => {
    const t = sealWith(S, "session", { uid: "u1" }, 60, NOW);
    expect(unsealWith(S, "session", t, NOW + 61_000)).toBeNull();
    const [body, tag] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ uid: "u2", typ: "session", exp: 9e9 })).toString("base64url");
    expect(unsealWith(S, "session", `${forged}.${tag}`, NOW)).toBeNull();
    expect(unsealWith("y".repeat(32), "session", t, NOW)).toBeNull();
    const untyped = Buffer.from(JSON.stringify({ uid: "u1", exp: 9e9 })).toString("base64url");
    expect(unsealWith(S, "session", `${untyped}.${macWith(S, untyped)}`, NOW)).toBeNull();
    expect(unsealWith(S, "session", `${body}.${tag}.x`, NOW)).toBeNull();
    expect(unsealWith(S, "session", undefined, NOW)).toBeNull();
  });
});
