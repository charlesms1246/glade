import { generateAuthenticationOptions } from "@simplewebauthn/server";
import { json } from "@/lib/server/api";
import { putChallenge, rp } from "@/lib/server/webauthn";

export async function POST() {
  const options = await generateAuthenticationOptions({ rpID: rp().rpID, userVerification: "required" });
  await putChallenge({ challenge: options.challenge, purpose: "login" });
  return json(options);
}
