import type { TmEnv } from "@glade/shared";
import { generateSignerKeyPair, openPrivateKey, sealPrivateKey, type SealedKey, type SignerKey } from "@glade/stamp";
import type { TmClient } from "@glade/tm-client";

export interface StoredSigner {
  publicKeyHex: string;
  sealed: SealedKey;
}

export interface TmUserRecord {
  tmUserId: string;
  externalRefId: string;
  solanaAddress: string | null;
  evmAddress: string | null;
}

export interface OnboardingRepo {
  getSigner(userId: string): Promise<StoredSigner | null>;
  saveSigner(userId: string, env: TmEnv, signer: StoredSigner): Promise<void>;
  getTmUser(userId: string): Promise<TmUserRecord | null>;
  saveTmUser(userId: string, env: TmEnv, rec: TmUserRecord): Promise<void>;
}

/** Stable id True Markets uses to make user creation idempotent. */
export const externalRefId = (userId: string) => `glade_${userId}`;

/**
 * Give a Glade user a signer key and a Gateway user with wallets. Safe to re-run:
 * an existing signer is reused (a user can only ever sign with the key it was created with),
 * and True Markets returns the same user for the same external_ref_id.
 */
export async function onboardUser(
  deps: { tm: TmClient; repo: OnboardingRepo; masterKey: Buffer; env: TmEnv },
  userId: string,
): Promise<TmUserRecord> {
  const existing = await deps.repo.getTmUser(userId);
  if (existing) return existing;

  let signer = await deps.repo.getSigner(userId);
  if (!signer) {
    const kp = generateSignerKeyPair();
    signer = { publicKeyHex: kp.publicKeyHex, sealed: sealPrivateKey(kp.privateKeyHex, deps.masterKey) };
    await deps.repo.saveSigner(userId, deps.env, signer);
  }

  const user = await deps.tm.createUser({ external_ref_id: externalRefId(userId), signer_public_key: signer.publicKeyHex });
  const find = (pred: (chain: string) => boolean) => user.wallets.find((w) => pred(String(w.chain ?? "").toLowerCase()))?.address ?? null;
  const rec: TmUserRecord = {
    tmUserId: user.user_id,
    externalRefId: externalRefId(userId),
    solanaAddress: find((c) => c === "solana"),
    evmAddress: find((c) => c === "evm" || c === "base" || c === "ethereum"),
  };
  await deps.repo.saveTmUser(userId, deps.env, rec);
  return rec;
}

/** Decrypt a user's signer key for stamping. */
export async function loadSigner(repo: OnboardingRepo, masterKey: Buffer, userId: string): Promise<SignerKey> {
  const s = await repo.getSigner(userId);
  if (!s) throw new Error(`no signer key for user ${userId}`);
  return { publicKeyHex: s.publicKeyHex, privateKeyHex: openPrivateKey(s.sealed, masterKey) };
}

export function memoryOnboardingRepo(): OnboardingRepo & { signers: Map<string, StoredSigner>; users: Map<string, TmUserRecord> } {
  const signers = new Map<string, StoredSigner>();
  const users = new Map<string, TmUserRecord>();
  return {
    signers,
    users,
    async getSigner(id) {
      return signers.get(id) ?? null;
    },
    async saveSigner(id, _env, s) {
      if (signers.has(id)) throw new Error("signer already exists");
      signers.set(id, s);
    },
    async getTmUser(id) {
      return users.get(id) ?? null;
    },
    async saveTmUser(id, _env, r) {
      users.set(id, r);
    },
  };
}
