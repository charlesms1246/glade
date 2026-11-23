import { generateRegistrationOptions } from "@simplewebauthn/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { fail, json } from "@/lib/server/api";
import { putChallenge, rp } from "@/lib/server/webauthn";
import { readJson } from "@/lib/server/body";

const body = z.object({ name: z.string().trim().min(1).max(40) });

export async function POST(req: Request) {
  const parsed = body.safeParse(await readJson(req));
  if (!parsed.success) return fail(400, "Choose a name of 1–40 characters.");
  const uid = randomUUID();
  const { rpID, rpName } = rp();
  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userName: parsed.data.name,
    userID: new Uint8Array(Buffer.from(uid.replaceAll("-", ""), "hex")),
    attestationType: "none",
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  });
  await putChallenge({ challenge: options.challenge, purpose: "register", uid, name: parsed.data.name });
  return json(options);
}
