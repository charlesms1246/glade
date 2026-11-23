import { createHmac, timingSafeEqual } from "node:crypto";

/** Token kinds; a token sealed for one kind never unseals as another. */
export type SealType = "session" | "wa";

export const macWith = (secret: string, data: string) => createHmac("sha256", secret).update(data).digest("base64url");

export function macOkWith(secret: string, data: string, tag: string): boolean {
  const a = Buffer.from(macWith(secret, data));
  const b = Buffer.from(tag);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** `base64url(json).hmac`, carrying its kind and an expiry (unix seconds). */
export function sealWith(secret: string, typ: SealType, payload: object, ttlSec: number, nowMs = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ ...payload, typ, exp: Math.floor(nowMs / 1000) + ttlSec })).toString("base64url");
  return `${body}.${macWith(secret, body)}`;
}

export function unsealWith<T>(secret: string, typ: SealType, token: string | undefined, nowMs = Date.now()): T | null {
  if (!token) return null;
  const [body, tag, extra] = token.split(".");
  if (!body || !tag || extra !== undefined || !macOkWith(secret, body, tag)) return null;
  let data: T & { typ?: unknown; exp?: unknown };
  try {
    data = JSON.parse(Buffer.from(body, "base64url").toString()) as T & { typ?: unknown; exp?: unknown };
  } catch {
    return null;
  }
  return data.typ === typ && typeof data.exp === "number" && data.exp > nowMs / 1000 ? data : null;
}
