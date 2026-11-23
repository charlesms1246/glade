import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { fail, json } from "@/lib/server/api";
import { startSession } from "@/lib/server/session";
import { takeChallenge, verifyAssertion } from "@/lib/server/webauthn";
import { readJson } from "@/lib/server/body";

export async function POST(req: Request) {
  const pending = await takeChallenge("login");
  if (!pending) return fail(400, "The passkey request expired. Try again.");
  const response = (await readJson(req)) as AuthenticationResponseJSON | null;
  if (!response?.id) return fail(400, "Missing passkey response.");
  const uid = await verifyAssertion(response, pending.challenge, null);
  if (!uid) return fail(401, "That passkey is not registered with Glade.");
  await startSession(uid);
  return json({ ok: true, next: "/home" });
}
