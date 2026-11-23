import "server-only";
import { schema } from "@glade/db";
import { planChallenge } from "@glade/shared";
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
} from "@simplewebauthn/server";
import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { db } from "./db";
import { cookieOpts, seal, unseal } from "./session";

const CHALLENGE_COOKIE = "glade_wa";
const CHALLENGE_TTL_SEC = 300;

export function rp() {
  const origin = process.env.APP_ORIGIN;
  const rpID = process.env.WEBAUTHN_RP_ID;
  if (!origin || !rpID) throw new Error("APP_ORIGIN and WEBAUTHN_RP_ID must be set");
  return { origin, rpID, rpName: "Glade" };
}

export interface PendingChallenge {
  challenge: string;
  purpose: "register" | "login";
  uid?: string;
  name?: string;
}

export async function putChallenge(c: PendingChallenge) {
  (await cookies()).set(CHALLENGE_COOKIE, seal("wa", c, CHALLENGE_TTL_SEC), cookieOpts(CHALLENGE_TTL_SEC));
}

/** Read and clear the pending challenge, so each one is used at most once. */
export async function takeChallenge(purpose: PendingChallenge["purpose"]): Promise<PendingChallenge | null> {
  const jar = await cookies();
  const c = unseal<PendingChallenge>("wa", jar.get(CHALLENGE_COOKIE)?.value);
  jar.delete(CHALLENGE_COOKIE);
  return c?.purpose === purpose ? c : null;
}

async function userPasskeys(userId: string) {
  return db().select().from(schema.passkeys).where(eq(schema.passkeys.userId, userId));
}

/** Passkey request options whose challenge is the plan hash: the user approves exactly this plan. */
export async function planAssertionOptions(userId: string, hash: string) {
  const keys = await userPasskeys(userId);
  return generateAuthenticationOptions({
    rpID: rp().rpID,
    challenge: Buffer.from(hash, "hex"),
    userVerification: "required",
    allowCredentials: keys.map((k) => ({ id: k.credentialId, transports: (k.transports ?? []) as AuthenticatorTransport[] })),
  });
}

/**
 * Verify an assertion from one of `userId`'s passkeys (any user when null) against `expectedChallenge`,
 * then store the new signature counter. Returns the owning user id, or null if it does not verify.
 */
export async function verifyAssertion(
  response: AuthenticationResponseJSON,
  expectedChallenge: string,
  userId: string | null,
): Promise<string | null> {
  const [key] = await db().select().from(schema.passkeys).where(eq(schema.passkeys.credentialId, response.id));
  if (!key || (userId && key.userId !== userId)) return null;
  const { origin, rpID } = rp();
  try {
    const v = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
      credential: {
        id: key.credentialId,
        publicKey: new Uint8Array(key.publicKey),
        counter: key.counter,
        transports: (key.transports ?? []) as AuthenticatorTransport[],
      },
    });
    if (!v.verified) return null;
    await db().update(schema.passkeys).set({ counter: v.authenticationInfo.newCounter }).where(eq(schema.passkeys.id, key.id));
    return key.userId;
  } catch {
    return null;
  }
}

/** Verify a plan approval: the assertion's challenge must be the plan hash. */
export const verifyPlanAssertion = (userId: string, response: AuthenticationResponseJSON, hash: string) =>
  verifyAssertion(response, planChallenge(hash), userId);
