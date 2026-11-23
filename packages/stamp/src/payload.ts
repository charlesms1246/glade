import { createECDH, createPrivateKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";

export const STAMP_SCHEME = "SIGNATURE_SCHEME_TK_API_P256";

export interface SignerKey {
  /** Compressed P-256 public key, 33 bytes hex. */
  publicKeyHex: string;
  /** P-256 private scalar, 32 bytes hex. */
  privateKeyHex: string;
}

function privateKeyObject(privateKeyHex: string): { key: KeyObject; publicKeyHex: string } {
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(privateKeyHex, "hex"));
  const point = ecdh.getPublicKey(); // 0x04 || x || y
  const key = createPrivateKey({
    format: "jwk",
    key: {
      kty: "EC",
      crv: "P-256",
      d: Buffer.from(privateKeyHex, "hex").toString("base64url"),
      x: point.subarray(1, 33).toString("base64url"),
      y: point.subarray(33).toString("base64url"),
    },
  });
  return { key, publicKeyHex: ecdh.getPublicKey("hex", "compressed") };
}

/**
 * Stamp one payload exactly as received (UTF-8, trailing newline included):
 * ECDSA P-256 SHA-256, DER signature as hex, wrapped in a base64url JSON envelope.
 */
export function stampPayload(payload: string, signer: SignerKey): string {
  const { key, publicKeyHex } = privateKeyObject(signer.privateKeyHex);
  if (publicKeyHex !== signer.publicKeyHex.toLowerCase()) {
    throw new Error("signer public key does not match private key");
  }
  const signature = sign("sha256", Buffer.from(payload, "utf8"), key).toString("hex");
  const json = JSON.stringify({ publicKey: publicKeyHex, signature, scheme: STAMP_SCHEME });
  return Buffer.from(json).toString("base64url");
}

export function generateSignerKeyPair(): SignerKey {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const d = privateKey.export({ format: "jwk" }).d!;
  const privateKeyHex = Buffer.from(d, "base64url").toString("hex").padStart(64, "0");
  return { privateKeyHex, publicKeyHex: privateKeyObject(privateKeyHex).publicKeyHex };
}
