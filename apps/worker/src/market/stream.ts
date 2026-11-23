import type { TmClient } from "@glade/tm-client";
import { z } from "zod";
import type { AssetClass, PriceCache } from "./price-cache";

const priceMsg = z.object({
  type: z.literal("price"),
  data: z.object({
    symbol: z.string(),
    asset_class: z.enum(["spot", "perp"]),
    price: z.string().regex(/^\d+(\.\d+)?$/),
    timestamp: z.string(),
  }),
});

export interface Instrument {
  symbol: string;
  cls: AssetClass;
}

type WsLike = {
  onopen: (() => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: ((e: unknown) => void) | null;
  send(data: string): void;
  close(): void;
};

export interface MarketStreamOptions {
  url: string;
  cache: PriceCache;
  tm: Pick<TmClient, "prices">;
  makeSocket?: (url: string) => WsLike;
  log?: (event: string, fields: Record<string, unknown>) => void;
  now?: () => Date;
  /** Fall back to REST for instruments without a tick for this long. */
  staleMs?: number;
}

export const topicFor = (i: Instrument) => `price.${i.symbol.toUpperCase()}${i.cls === "perp" ? "-PERP" : ""}`;

/** Public price feed: WebSocket first, REST poll for anything stale. Subscribes only to watched symbols. */
export class MarketStream {
  private ws: WsLike | undefined;
  private readonly watched = new Map<string, Instrument>();
  private reconnectDelay = 1000;
  private stopped = false;
  private readonly log;
  private readonly now;

  constructor(private readonly o: MarketStreamOptions) {
    this.log = o.log ?? (() => {});
    this.now = o.now ?? (() => new Date());
  }

  watch(instruments: Instrument[]): void {
    const added = instruments.filter((i) => !this.watched.has(topicFor(i)));
    for (const i of added) this.watched.set(topicFor(i), i);
    if (added.length && this.ws) this.ws.send(JSON.stringify({ type: "subscribe", topics: added.map(topicFor) }));
  }

  start(): void {
    this.stopped = false;
    const ws = (this.o.makeSocket ?? ((u) => new WebSocket(u) as unknown as WsLike))(this.o.url);
    this.ws = ws;
    ws.onopen = () => {
      this.reconnectDelay = 1000;
      const topics = [...this.watched.keys()];
      if (topics.length) ws.send(JSON.stringify({ type: "subscribe", topics }));
      this.log("ws_open", { topics: topics.length });
    };
    ws.onmessage = (e) => this.handle(String(e.data));
    ws.onerror = (e) => this.log("ws_error", { error: String((e as { message?: string })?.message ?? e) });
    ws.onclose = () => {
      this.ws = undefined;
      if (this.stopped) return;
      this.log("ws_closed", { retryInMs: this.reconnectDelay });
      setTimeout(() => this.start(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
    };
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
  }

  handle(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const r = priceMsg.safeParse(parsed);
    if (!r.success) return;
    const d = r.data.data;
    const at = new Date(d.timestamp);
    this.o.cache.set(d.symbol, d.asset_class, d.price, Number.isNaN(at.getTime()) ? this.now() : at, "ws");
  }

  /** REST fallback for watched instruments without a recent tick. Returns how many were refreshed. */
  async refreshStale(): Promise<number> {
    const now = this.now();
    const stale = [...this.watched.values()].filter((i) => !this.o.cache.fresh(i.symbol, i.cls, now, this.o.staleMs ?? 30_000));
    let n = 0;
    for (const i of stale) {
      try {
        const r = await this.o.tm.prices(i.symbol, i.cls);
        const px = r.candles?.find((c) => c.interval === "1h")?.closePrice ?? r.candles?.[0]?.closePrice;
        if (px) {
          this.o.cache.set(i.symbol, i.cls, px, now, "rest");
          n++;
        }
      } catch (e) {
        this.log("rest_price_error", { symbol: i.symbol, cls: i.cls, error: String(e) });
      }
    }
    return n;
  }
}
