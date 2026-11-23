/** In-memory sliding-window limiter: at most `limit` hits per key within `windowMs`. */
export function slidingWindow(limit: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return {
    /** Records a hit and returns true when it is within the limit. */
    allow(key: string, now = Date.now()): boolean {
      const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
      if (recent.length >= limit) {
        hits.set(key, recent);
        return false;
      }
      recent.push(now);
      hits.set(key, recent);
      if (hits.size > 10_000) for (const [k, v] of hits) if (v.every((t) => now - t >= windowMs)) hits.delete(k);
      return true;
    },
  };
}

/** Client IP as seen by the first proxy, or "local". */
export const clientIp = (req: Request) =>
  req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "local";
