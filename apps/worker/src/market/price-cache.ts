import { dec, type Decimal } from "@glade/shared";

export type AssetClass = "spot" | "perp";
export interface Quote {
  px: Decimal;
  at: Date;
  source: "ws" | "rest";
}

const key = (symbol: string, cls: AssetClass) => `${symbol.toUpperCase()}:${cls}`;

/** Latest price per (symbol, class). Staleness is judged by the caller against an explicit `now`. */
export class PriceCache {
  private readonly m = new Map<string, Quote>();

  set(symbol: string, cls: AssetClass, px: string, at: Date, source: Quote["source"]): void {
    const cur = this.m.get(key(symbol, cls));
    if (cur && cur.at > at) return;
    this.m.set(key(symbol, cls), { px: dec(px), at, source });
  }

  get(symbol: string, cls: AssetClass): Quote | undefined {
    return this.m.get(key(symbol, cls));
  }

  fresh(symbol: string, cls: AssetClass, now: Date, maxAgeMs: number): Quote | undefined {
    const q = this.get(symbol, cls);
    return q && now.getTime() - q.at.getTime() <= maxAgeMs ? q : undefined;
  }
}
