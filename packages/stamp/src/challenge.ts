import { createPrivateKey, sign, type JsonWebKey } from "node:crypto";

/** ES256 signature over "{keyId}.{timestamp}", raw r||s (IEEE-P1363), base64url. */
export function signChallenge(keyId: string, timestampSec: number, privateJwk: JsonWebKey): string {
  const key = createPrivateKey({ key: privateJwk, format: "jwk" });
  return sign("sha256", Buffer.from(`${keyId}.${timestampSec}`), {
    key,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
}

export interface TokenRequest {
  key_id: string;
  timestamp: number;
  signature: string;
}

/** Body for POST /v1/auth/api-key/token. */
export function buildTokenRequest(keyId: string, privateJwk: JsonWebKey, nowMs: number): TokenRequest {
  const timestamp = Math.floor(nowMs / 1000);
  return { key_id: keyId, timestamp, signature: signChallenge(keyId, timestamp, privateJwk) };
}
