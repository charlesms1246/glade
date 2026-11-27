/** Counts True Markets API calls by day, method, route template and status class. No ids, queries, headers or bodies. */

const PARENT_PLACEHOLDER: Record<string, string> = {
  organizations: "{org}",
  users: "{user}",
  orders: "{id}",
  assets: "{id}",
  transactions: "{id}",
};
const ID_LIKE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|0x[0-9a-f]+|\d+|[A-Za-z0-9_-]{16,})$/i;

/** Path template of a request URL: query dropped, identifiers replaced by placeholders. */
export function normaliseRoute(url: string): string {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    path = url.split("?")[0]!;
  }
  const parts = path.split("/").filter(Boolean);
  const out = parts.map((seg, i) => {
    const parent = parts[i - 1];
    if (parent && PARENT_PLACEHOLDER[parent] && !/^(?:execute|cancel|quote|positions|portfolio|history)$/.test(seg) && /\d/.test(seg)) {
      return PARENT_PLACEHOLDER[parent]!;
    }
    return ID_LIKE.test(seg) && /\d/.test(seg) ? "{id}" : seg;
  });
  return "/" + out.join("/");
}

export const statusClass = (status: number): string => `${Math.floor(status / 100)}xx`;

export interface CallRow {
  day: string;
  method: string;
  route: string;
  statusClass: string;
  count: number;
}

/** In-memory tally flushed in batches; a failed flush keeps the counts for the next attempt. */
export class CallCounter {
  private counts = new Map<string, CallRow>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  record(method: string, url: string, status: number): void {
    const day = this.now().toISOString().slice(0, 10);
    const m = method.toUpperCase();
    const route = normaliseRoute(url);
    const sc = statusClass(status);
    const key = `${day}|${m}|${route}|${sc}`;
    const cur = this.counts.get(key);
    if (cur) cur.count++;
    else this.counts.set(key, { day, method: m, route, statusClass: sc, count: 1 });
  }

  async flush(write: (rows: CallRow[]) => Promise<void>): Promise<void> {
    if (this.counts.size === 0) return;
    const taken = this.counts;
    this.counts = new Map();
    try {
      await write([...taken.values()]);
    } catch (e) {
      for (const [k, r] of taken) {
        const cur = this.counts.get(k);
        if (cur) cur.count += r.count;
        else this.counts.set(k, r);
      }
      throw e;
    }
  }
}
