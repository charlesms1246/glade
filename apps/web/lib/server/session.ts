import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { macOkWith, macWith, sealWith, unsealWith, type SealType } from "./seal-core";

const SESSION_COOKIE = "glade_session";
const SESSION_TTL_SEC = 24 * 3600;

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error("SESSION_SECRET must be set (32+ chars)");
  return s;
}

/** HMAC tag for server-issued values (plan and mandate offers); callers prefix a domain. */
export const mac = (data: string) => macWith(secret(), data);
export const macOk = (data: string, tag: string) => macOkWith(secret(), data, tag);
export const seal = (typ: SealType, payload: object, ttlSec: number) => sealWith(secret(), typ, payload, ttlSec);
export const unseal = <T>(typ: SealType, token: string | undefined) => unsealWith<T>(secret(), typ, token);

export const cookieOpts = (maxAge: number) => ({
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.APP_ORIGIN?.startsWith("https://") ?? false,
  path: "/",
  maxAge,
});

export async function startSession(userId: string) {
  (await cookies()).set(SESSION_COOKIE, seal("session", { uid: userId }, SESSION_TTL_SEC), cookieOpts(SESSION_TTL_SEC));
}

export async function endSession() {
  (await cookies()).delete(SESSION_COOKIE);
}

/** The raw session cookie, for long-lived requests that re-check it later. */
export const sessionToken = async () => (await cookies()).get(SESSION_COOKIE)?.value;

/** The user id a session token is valid for right now, or null. */
export const userIdFromToken = (token: string | undefined) => unseal<{ uid: string }>("session", token)?.uid ?? null;

/** The signed-in app user id, or null. */
export async function sessionUserId(): Promise<string | null> {
  return userIdFromToken(await sessionToken());
}

/** For pages: the signed-in user id, or a redirect to sign in. */
export async function requireUserId(): Promise<string> {
  const uid = await sessionUserId();
  if (!uid) redirect("/login");
  return uid;
}
