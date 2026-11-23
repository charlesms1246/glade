// A software WebAuthn authenticator for test scripts: a P-256 key that produces real assertions
// verifiable by @simplewebauthn/server. Never used by the app itself.
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";

export interface SoftPasskey {
  credentialId: string;
  /** COSE_Key (EC2, ES256) bytes, as stored in passkeys.public_key. */
  cosePublicKey: Buffer;
  assert: (challengeB64url: string) => unknown;
}

export function createSoftPasskey(rpId: string, origin: string): SoftPasskey {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const x = Buffer.from(jwk.x!, "base64url");
  const y = Buffer.from(jwk.y!, "base64url");
  // CBOR map {1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y}
  const cose = Buffer.concat([Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]), x, Buffer.from([0x22, 0x58, 0x20]), y]);
  const id = randomBytes(16).toString("base64url");
  let counter = 0;
  return {
    credentialId: id,
    cosePublicKey: cose,
    assert: (challenge) => assertion(privateKey, id, rpId, origin, challenge, ++counter),
  };
}

function assertion(key: KeyObject, id: string, rpId: string, origin: string, challenge: string, counter: number) {
  const ctr = Buffer.alloc(4);
  ctr.writeUInt32BE(counter);
  // rpIdHash || flags (user present + user verified) || signCount
  const authData = Buffer.concat([createHash("sha256").update(rpId).digest(), Buffer.from([0x05]), ctr]);
  const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin, crossOrigin: false }));
  const sig = sign("sha256", Buffer.concat([authData, createHash("sha256").update(clientData).digest()]), key);
  return {
    id,
    rawId: id,
    type: "public-key",
    clientExtensionResults: {},
    response: {
      authenticatorData: authData.toString("base64url"),
      clientDataJSON: clientData.toString("base64url"),
      signature: sig.toString("base64url"),
    },
  };
}
