import { buildTokenRequest } from "@glade/stamp";
import type { JsonWebKey } from "node:crypto";
import { z } from "zod";
import { TmApiError } from "./errors";

const REMINT_AFTER_MS = 55 * 60 * 1000;

const tokenResponse = z.object({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  // Org keys return an RFC3339 timestamp here, not seconds.
  expires_in: z.union([z.string(), z.number()]),
  refresh_token: z.string().optional(),
});

export interface OrgKey {
  key_id: string;
  private_key: JsonWebKey;
}

export interface TokenClaims {
  organizationId: string | undefined;
  role: string | undefined;
}

export interface MintedToken {
  accessToken: string;
  expiresAt: number;
  claims: TokenClaims;
}

export function decodeClaims(jwt: string): TokenClaims {
  const part = jwt.split(".")[1];
  if (!part) throw new Error("malformed JWT");
  const p = JSON.parse(Buffer.from(part, "base64url").toString()) as {
    role?: string;
    tm?: { organization_id?: string };
  };
  return { organizationId: p.tm?.organization_id, role: p.role };
}

export type MintFn = () => Promise<MintedToken>;

/** Mints an org token from the API key. Token minting is limited per IP, so callers must cache. */
export function apiKeyMinter(opts: {
  restBase: string;
  key: OrgKey;
  fetch?: typeof fetch;
  now?: () => number;
}): MintFn {
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  return async () => {
    const mintedAt = now();
    const body = buildTokenRequest(opts.key.key_id, opts.key.private_key, mintedAt);
    const res = await doFetch(`${opts.restBase}/v1/auth/api-key/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json: unknown = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new TmApiError(res.status, json, "POST", "/v1/auth/api-key/token");
    }
    const t = tokenResponse.parse(json);
    const serverExpiry =
      typeof t.expires_in === "string" ? Date.parse(t.expires_in) : mintedAt + t.expires_in * 1000;
    const expiresAt = Math.min(
      Number.isFinite(serverExpiry) ? serverExpiry : Infinity,
      mintedAt + REMINT_AFTER_MS,
    );
    return { accessToken: t.access_token, expiresAt, claims: decodeClaims(t.access_token) };
  };
}

/** Caches one token per process; re-mints before expiry or after invalidate(). Concurrent callers share one mint. */
export class TokenManager {
  private current: MintedToken | undefined;
  private inflight: Promise<MintedToken> | undefined;

  constructor(
    private readonly mint: MintFn,
    private readonly now: () => number = Date.now,
  ) {}

  async get(): Promise<MintedToken> {
    if (this.current && this.now() < this.current.expiresAt) return this.current;
    if (!this.inflight) {
      this.inflight = this.mint()
        .then((t) => (this.current = t))
        .finally(() => (this.inflight = undefined));
    }
    return this.inflight;
  }

  /** Drop the cached token if it is the one that just failed. */
  invalidate(accessToken?: string): void {
    if (!accessToken || this.current?.accessToken === accessToken) this.current = undefined;
  }

  async organizationId(): Promise<string> {
    const id = (await this.get()).claims.organizationId;
    if (!id) throw new Error("token has no tm.organization_id: the API key is not an organization key");
    return id;
  }
}
