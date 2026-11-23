import { createHash } from "node:crypto";
import Decimal from "decimal.js";

function canon(v: unknown): unknown {
  if (Decimal.isDecimal(v)) return (v as Decimal).toString();
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v as object)
        .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
        .sort()
        .map((k) => [k, canon((v as Record<string, unknown>)[k])]),
    );
  }
  if (typeof v === "number") return String(v);
  return v;
}

/** Deterministic JSON: sorted keys, numbers/decimals as strings, dates as ISO, undefined dropped. */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(canon(v));
}

/** sha256 hex of the canonical JSON. The passkey challenge for approving a plan is these 32 bytes. */
export function planHash(v: unknown): string {
  return createHash("sha256").update(canonicalJson(v)).digest("hex");
}

/** WebAuthn challenge (base64url) for a plan hash. */
export function planChallenge(planHashHex: string): string {
  return Buffer.from(planHashHex, "hex").toString("base64url");
}
