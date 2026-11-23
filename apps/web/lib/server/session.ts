import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

const SESSION_COOKIE = "glade_session";
const SESSION_TTL_SEC = 7 * 24 * 3600;

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error("SESSION_SECRET must be set (32+ chars)");
  return s;
}

export function mac(data: string): string {
  return createHmac("sha256", secret()).update(data).digest("base64url");
}

export function macOk(data: string, tag: string): boolean {
  const a = Buffer.from(mac(data));
  const b = Buffer.from(tag);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** `base64url(json).hmac`, with an `exp` (unix seconds) checked on read. */
export function seal(payload: object, ttlSec: number): string {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec })).toString("base64url");
  return `${body}.${mac(body)}`;
}

export function unseal<T>(token: string | undefined): T | null {
  if (!token) return null;
  const [body, tag] = token.split(".");
  if (!body || !tag || !macOk(body, tag)) return null;
  const data = JSON.parse(Buffer.from(body, "base64url").toString()) as T & { exp: number };
  return data.exp > Date.now() / 1000 ? data : null;
}

export const cookieOpts = (maxAge: number) => ({
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.APP_ORIGIN?.startsWith("https://") ?? false,
  path: "/",
  maxAge,
});

export async function startSession(userId: string) {
  (await cookies()).set(SESSION_COOKIE, seal({ uid: userId }, SESSION_TTL_SEC), cookieOpts(SESSION_TTL_SEC));
}

export async function endSession() {
  (await cookies()).delete(SESSION_COOKIE);
}

/** The signed-in app user id, or null. */
export async function sessionUserId(): Promise<string | null> {
  return unseal<{ uid: string }>((await cookies()).get(SESSION_COOKIE)?.value)?.uid ?? null;
}

/** For pages: the signed-in user id, or a redirect to sign in. */
export async function requireUserId(): Promise<string> {
  const uid = await sessionUserId();
  if (!uid) redirect("/login");
  return uid;
}
