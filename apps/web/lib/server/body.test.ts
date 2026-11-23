import { describe, expect, it } from "vitest";
import { readJson } from "./body";

const post = (body: string, headers: Record<string, string> = {}) => new Request("http://x/", { method: "POST", body, headers });

describe("readJson", () => {
  it("parses a small body", async () => {
    expect(await readJson(post('{"a":1}'))).toEqual({ a: 1 });
  });
  it("rejects bodies over the cap, whatever content-length says", async () => {
    const big = JSON.stringify({ s: "x".repeat(100) });
    expect(await readJson(post(big), 50)).toBeNull();
    expect(await readJson(post(big, { "content-length": "10" }), 50)).toBeNull();
    expect(await readJson(post("{}", { "content-length": "999999" }), 50)).toBeNull();
  });
  it("returns null for malformed or empty bodies", async () => {
    expect(await readJson(post("{nope"))).toBeNull();
    expect(await readJson(new Request("http://x/", { method: "POST" }))).toBeNull();
  });
});
