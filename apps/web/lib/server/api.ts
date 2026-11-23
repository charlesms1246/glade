import "server-only";
import { NextResponse } from "next/server";
import { sessionUserId } from "./session";

export const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
export const fail = (status: number, error: string) => json({ error }, status);

/** Run a route body for the signed-in user; 401 otherwise. */
export async function withUser(fn: (userId: string) => Promise<Response>): Promise<Response> {
  const uid = await sessionUserId();
  if (!uid) return fail(401, "Sign in first.");
  try {
    return await fn(uid);
  } catch (e) {
    console.error(e);
    return fail(500, "Something went wrong. Nothing was placed.");
  }
}
