import type { TokenManager } from "./token";

export interface HttpOptions {
  tokens?: TokenManager;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Max retries for 429 responses. */
  max429Retries?: number;
  onResponse?: (info: { method: string; url: string; status: number; requestId: string | null }) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Seconds until the window resets. Accepts a delta in seconds or an epoch-seconds value. */
export function retryDelayMs(res: Response, now: number): number {
  const raw = res.headers.get("x-ratelimit-reset") ?? res.headers.get("retry-after");
  const n = raw ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n < 0) return 1000;
  const sec = n > 1e9 ? n - now / 1000 : n;
  return Math.min(Math.max(Math.ceil(sec * 1000), 250), 60_000);
}

/**
 * A fetch that adds the org bearer token, re-mints once on 401, and waits out 429s
 * using X-RateLimit-Reset. Plug into openapi-fetch via `createClient({ fetch })`.
 */
export function createTmFetch(opts: HttpOptions): (input: Request) => Promise<Response> {
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const max429 = opts.max429Retries ?? 3;

  return async (input: Request) => {
    const original = input.clone();
    let reminted = false;
    let rateRetries = 0;
    for (;;) {
      const req = original.clone();
      let token: string | undefined;
      if (opts.tokens) {
        token = (await opts.tokens.get()).accessToken;
        req.headers.set("Authorization", `Bearer ${token}`);
      }
      const res = await doFetch(req);
      opts.onResponse?.({
        method: req.method,
        url: req.url,
        status: res.status,
        requestId: res.headers.get("x-request-id"),
      });
      if (res.status === 401 && opts.tokens && !reminted) {
        reminted = true;
        opts.tokens.invalidate(token);
        continue;
      }
      if (res.status === 429 && rateRetries < max429) {
        rateRetries++;
        await sleep(retryDelayMs(res, now()));
        continue;
      }
      return res;
    }
  };
}
