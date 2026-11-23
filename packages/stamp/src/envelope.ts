import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALG = "AES-256-GCM" as const;

/** A private key encrypted with a per-row data key, which is itself wrapped by the master key. */
export interface SealedKey {
  alg: typeof ALG;
  /** ciphertext || 16-byte auth tag of the private key, base64. */
  encPrivateKey: string;
  /** 12-byte IV used with the data key, base64. */
  iv: string;
  /** ciphertext || 16-byte auth tag of the data key under the master key, base64. */
  encDataKey: string;
  /** 12-byte IV used with the master key, base64. */
  dataKeyIv: string;
}

function encrypt(key: Buffer, plaintext: Buffer): { ct: Buffer; iv: Buffer } {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()]);
  return { ct, iv };
}

function decrypt(key: Buffer, iv: Buffer, ctWithTag: Buffer): Buffer {
  const d = createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(ctWithTag.subarray(-16));
  return Buffer.concat([d.update(ctWithTag.subarray(0, -16)), d.final()]);
}

function assertKey(k: Buffer): void {
  if (k.length !== 32) throw new Error("master key must be 32 bytes");
}

export function sealPrivateKey(privateKeyHex: string, masterKey: Buffer): SealedKey {
  assertKey(masterKey);
  const dataKey = randomBytes(32);
  const pk = encrypt(dataKey, Buffer.from(privateKeyHex, "hex"));
  const dk = encrypt(masterKey, dataKey);
  return {
    alg: ALG,
    encPrivateKey: pk.ct.toString("base64"),
    iv: pk.iv.toString("base64"),
    encDataKey: dk.ct.toString("base64"),
    dataKeyIv: dk.iv.toString("base64"),
  };
}

export function openPrivateKey(sealed: SealedKey, masterKey: Buffer): string {
  assertKey(masterKey);
  if (sealed.alg !== ALG) throw new Error(`unsupported alg ${sealed.alg}`);
  const dataKey = decrypt(masterKey, Buffer.from(sealed.dataKeyIv, "base64"), Buffer.from(sealed.encDataKey, "base64"));
  return decrypt(dataKey, Buffer.from(sealed.iv, "base64"), Buffer.from(sealed.encPrivateKey, "base64")).toString("hex");
}

/** Parse "base64:<32 bytes>". Errors never include the value. */
export function parseMasterKey(value: string): Buffer {
  if (!value.startsWith("base64:")) throw new Error("master key must start with base64:");
  const k = Buffer.from(value.slice(7), "base64");
  if (k.length !== 32) throw new Error("master key must decode to 32 bytes");
  return k;
}
