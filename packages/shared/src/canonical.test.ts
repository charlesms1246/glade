import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { canonicalJson, planChallenge, planHash } from "./canonical";
import { dec } from "./money";

describe("canonicalJson / planHash", () => {
  it("is independent of key order and number vs string", () => {
    expect(canonicalJson({ b: 1, a: { d: dec("2.50"), c: [3] } })).toBe('{"a":{"c":["3"],"d":"2.5"},"b":"1"}');
    expect(planHash({ x: 1, y: "a" })).toBe(planHash({ y: "a", x: "1" }));
  });
  it("drops undefined fields", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":"1"}');
  });
  it("challenge is the 32 hash bytes, base64url", () => {
    const h = planHash({ a: 1 });
    expect(Buffer.from(planChallenge(h), "base64url").toString("hex")).toBe(h);
  });
  it("property: key permutation never changes the hash", () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string({ maxLength: 5 }), fc.oneof(fc.integer(), fc.string())), (o) => {
        const reversed = Object.fromEntries(Object.entries(o).reverse());
        return planHash(o) === planHash(reversed);
      }),
    );
  });
});
