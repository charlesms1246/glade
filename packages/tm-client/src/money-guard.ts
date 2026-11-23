/** Production True Markets hosts. Anything here moves real money if an order or transfer is sent. */
export const PRODUCTION_HOSTS = new Set(["api.truemarkets.co"]);

// The only writes allowed against production. None of them can move funds.
const PROD_WRITE_ALLOWLIST: readonly RegExp[] = [
  /^\/v1\/auth\/api-key\/token$/, // mint an org token
  /^\/v1\/account\/organizations\/[^/]+\/users$/, // create a Gateway user (no funds)
  /^\/v1\/gateway\/quotes$/, // price preview only; creates no order
];

export class RealMoneyBlockedError extends Error {
  constructor(method: string, path: string) {
    super(`blocked ${method} ${path}: Glade never sends money-moving requests to production`);
    this.name = "RealMoneyBlockedError";
  }
}

/** Throws for any non-read request to production that is not explicitly allowlisted. */
export function assertNoRealMoney(method: string, url: string): void {
  const u = new URL(url);
  if (!PRODUCTION_HOSTS.has(u.hostname)) return;
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return;
  if (PROD_WRITE_ALLOWLIST.some((re) => re.test(u.pathname))) return;
  throw new RealMoneyBlockedError(m, u.pathname);
}
