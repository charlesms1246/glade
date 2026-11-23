import { schema } from "@glade/db";
import { verifyRegistrationResponse, type RegistrationResponseJSON } from "@simplewebauthn/server";
import { fail, json } from "@/lib/server/api";
import { db } from "@/lib/server/db";
import { startSession } from "@/lib/server/session";
import { rp, takeChallenge } from "@/lib/server/webauthn";
import { readJson } from "@/lib/server/body";

export async function POST(req: Request) {
  const pending = await takeChallenge("register");
  if (!pending?.uid) return fail(400, "The passkey request expired. Try again.");
  const response = (await readJson(req)) as RegistrationResponseJSON | null;
  if (!response) return fail(400, "Missing passkey response.");
  const { origin, rpID } = rp();
  let v;
  try {
    v = await verifyRegistrationResponse({
      response,
      expectedChallenge: pending.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
    });
  } catch {
    return fail(400, "The passkey could not be verified.");
  }
  if (!v.verified) return fail(400, "The passkey could not be verified.");
  const { credential } = v.registrationInfo;
  const uid = pending.uid;
  await db().transaction(async (tx) => {
    await tx.insert(schema.appUsers).values({ id: uid, displayName: pending.name ?? null });
    await tx.insert(schema.passkeys).values({
      userId: uid,
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports ?? [],
    });
  });
  await startSession(uid);
  return json({ ok: true, next: "/onboarding" });
}
