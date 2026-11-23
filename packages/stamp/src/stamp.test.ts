import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { createPublicKey, generateKeyPairSync, randomBytes, verify } from "node:crypto";
import { ApiKeyStamper } from "@turnkey/api-key-stamper";
import { buildTokenRequest, signChallenge } from "./challenge";
import { generateSignerKeyPair, stampPayload, STAMP_SCHEME } from "./payload";
import { openPrivateKey, parseMasterKey, sealPrivateKey } from "./envelope";

function publicKeyFromCompressed(hex: string) {
  // SPKI DER prefix for a compressed P-256 point.
  const prefix = Buffer.from("3039301306072a8648ce3d020106082a8648ce3d030107032200", "hex");
  return createPublicKey({ key: Buffer.concat([prefix, Buffer.from(hex, "hex")]), format: "der", type: "spki" });
}

function decode(stamp: string) {
  return JSON.parse(Buffer.from(stamp, "base64url").toString("utf8"));
}

describe("challenge signing", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = privateKey.export({ format: "jwk" });

  it("produces a raw r||s ES256 signature that verifies", () => {
    const sig = signChallenge("kid-1", 1_700_000_000, jwk);
    const raw = Buffer.from(sig, "base64url");
    expect(raw.length).toBe(64);
    expect(
      verify("sha256", Buffer.from("kid-1.1700000000"), { key: publicKey, dsaEncoding: "ieee-p1363" }, raw),
    ).toBe(true);
  });

  it("builds the token request with unix seconds", () => {
    const r = buildTokenRequest("kid-1", jwk, 1_700_000_000_999);
    expect(r.timestamp).toBe(1_700_000_000);
    expect(r.key_id).toBe("kid-1");
  });
});

describe("payload stamp", () => {
  const signer = generateSignerKeyPair();
  const payload = '{"type":"ACTIVITY","organizationId":"x"}\n';

  it("signs the exact payload, trailing newline included", () => {
    const env = decode(stampPayload(payload, signer));
    expect(Object.keys(env)).toEqual(["publicKey", "signature", "scheme"]);
    expect(env.scheme).toBe(STAMP_SCHEME);
    expect(env.publicKey).toBe(signer.publicKeyHex);
    const pub = publicKeyFromCompressed(signer.publicKeyHex);
    const sig = Buffer.from(env.signature, "hex");
    expect(verify("sha256", Buffer.from(payload), pub, sig)).toBe(true);
    expect(verify("sha256", Buffer.from(payload.trimEnd()), pub, sig)).toBe(false);
  });

  it("matches the @turnkey/api-key-stamper envelope shape", async () => {
    const tk = new ApiKeyStamper({ apiPublicKey: signer.publicKeyHex, apiPrivateKey: signer.privateKeyHex });
    const theirs = decode((await tk.stamp(payload)).stampHeaderValue);
    const ours = decode(stampPayload(payload, signer));
    expect(Object.keys(ours).sort()).toEqual(Object.keys(theirs).sort());
    expect(ours.publicKey).toBe(theirs.publicKey);
    expect(ours.scheme).toBe(theirs.scheme);
    const pub = publicKeyFromCompressed(signer.publicKeyHex);
    for (const s of [ours, theirs]) {
      expect(verify("sha256", Buffer.from(payload), pub, Buffer.from(s.signature, "hex"))).toBe(true);
    }
  });

  it("rejects a mismatched public key", () => {
    const other = generateSignerKeyPair();
    expect(() => stampPayload(payload, { ...signer, publicKeyHex: other.publicKeyHex })).toThrow();
  });

  it("generates 33-byte compressed public keys and 32-byte private keys", () => {
    expect(signer.publicKeyHex).toMatch(/^0[23][0-9a-f]{64}$/);
    expect(signer.privateKeyHex).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("envelope encryption", () => {
  const master = randomBytes(32);

  it("round-trips", () => {
    const { privateKeyHex } = generateSignerKeyPair();
    expect(openPrivateKey(sealPrivateKey(privateKeyHex, master), master)).toBe(privateKeyHex);
  });

  it("detects tampering and wrong master keys", () => {
    const sealed = sealPrivateKey(generateSignerKeyPair().privateKeyHex, master);
    const ct = Buffer.from(sealed.encPrivateKey, "base64");
    ct[0] = ct[0]! ^ 1;
    expect(() => openPrivateKey({ ...sealed, encPrivateKey: ct.toString("base64") }, master)).toThrow();
    expect(() => openPrivateKey(sealed, randomBytes(32))).toThrow();
  });

  it("round-trips any 32-byte key (property)", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 32, maxLength: 32 }), (bytes) => {
        const hex = Buffer.from(bytes).toString("hex");
        return openPrivateKey(sealPrivateKey(hex, master), master) === hex;
      }),
      { numRuns: 50 },
    );
  });

  it("parses master keys without leaking the value", () => {
    expect(parseMasterKey(`base64:${master.toString("base64")}`).equals(master)).toBe(true);
    const short = randomBytes(16).toString("base64");
    try {
      parseMasterKey(`base64:${short}`);
      expect.unreachable();
    } catch (e) {
      expect(String(e)).not.toContain(short);
    }
  });
});
