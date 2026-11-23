import { schema } from "@glade/db";
import { eq } from "drizzle-orm";
import { verifyRegistrationResponse, type RegistrationResponseJSON } from "@simplewebauthn/server";
import { fail, json } from "@/lib/server/api";
import { db } from "@/lib/server/db";
import { startSession } from "@/lib/server/session";
import { signupLimited } from "@/lib/server/signup-limit";
import { rp, takeChallenge } from "@/lib/server/webauthn";
import { readJson } from "@/lib/server/body";

export async function POST(req: Request) {
  const limited = signupLimited("verify", req);
  if (limited) return limited;
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
  const taken = () => fail(409, "This passkey is already registered. Sign in instead.");
  const [existing] = await db().select({ id: schema.passkeys.id }).from(schema.passkeys).where(eq(schema.passkeys.credentialId, credential.id));
  if (existing) return taken();
  try {
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
  } catch (e) {
    if ((e as { code?: string }).code === "23505" || (e as { cause?: { code?: string } }).cause?.code === "23505") return taken();
    throw e;
  }
  await startSession(uid);
  return json({ ok: true, next: "/onboarding" });
}
