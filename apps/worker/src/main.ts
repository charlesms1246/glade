import { readFileSync } from "node:fs";
import { createDb, schema } from "@glade/db";
import { ENGINE_VERSION, referenceSpotSymbol } from "@glade/engine";
import { loadEnv, TM_BASE_URLS } from "@glade/shared";
import { apiKeyMinter, createTmClient, TokenManager, type OrgKey } from "@glade/tm-client";
import { and, eq } from "drizzle-orm";
import pino from "pino";
import { createBellService } from "./bell/service";
import { BELL_WATCHLIST, loadBellSigma, TICK_MS } from "./config";
import { bellRepo, logDecision, publish, tryLeaderLock } from "./db/repos";
import { PriceCache } from "./market/price-cache";
import { MarketStream } from "./market/stream";

const env = loadEnv();
const log = pino({ name: "glade-worker", level: process.env.LOG_LEVEL ?? "info" });
const urls = TM_BASE_URLS[env.TM_ENV];
const { db, sql } = createDb(env.DATABASE_URL, { max: 3 });

// Org mode needs an organization key. Without one the worker still runs public market data and Bell.
let tokens: TokenManager | undefined;
try {
  const key = JSON.parse(readFileSync(env.TM_ORG_KEY_FILE, "utf8")) as OrgKey;
  const tm = new TokenManager(apiKeyMinter({ restBase: urls.rest, key }));
  await tm.organizationId();
  tokens = tm;
  log.info({ env: env.TM_ENV }, "org mode: organization token ok");
} catch (e) {
  log.warn({ reason: String(e).slice(0, 200) }, "public-only mode: no usable organization key, trading disabled");
}

const tm = createTmClient({
  restBase: urls.rest,
  ...(tokens ? { tokens } : {}),
  onResponse: (r) => r.status >= 400 && log.warn({ ...r }, "tm_http_error"),
});

if (!(await tryLeaderLock(db))) {
  log.error("another worker holds the leader lock; exiting");
  await sql.end();
  process.exit(1);
}

// Tokenized stocks trade under issuer symbols (AAPLC, NVDAon, ...); market data needs a listed one.
const reg = schema.assetRegistry;
const spotSymbols = (
  await db
    .select({ symbol: reg.symbol })
    .from(reg)
    .where(and(eq(reg.env, env.TM_ENV), eq(reg.type, "spot"), eq(reg.assetClass, "stock")))
).map((r) => r.symbol);
if (spotSymbols.length === 0) log.warn("asset_registry is empty; run `pnpm seed:assets`");
const spotRef = new Map(BELL_WATCHLIST.map((s) => [s, referenceSpotSymbol(s, spotSymbols) ?? s]));

const cache = new PriceCache();
const stream = new MarketStream({ url: urls.ws, cache, tm, log: (ev, f) => log.info(f, ev) });
stream.watch(BELL_WATCHLIST.flatMap((symbol) => [{ symbol: spotRef.get(symbol)!, cls: "spot" as const }, { symbol, cls: "perp" as const }]));
stream.start();

const sigma = loadBellSigma(new URL("../../../docs/evidence/bell-calibration-NVDA.json", import.meta.url).pathname);
const bell = createBellService({
  repo: bellRepo(db),
  cache,
  sigma,
  priceBefore: async (group, cls, at) => {
    const symbol = cls === "spot" ? (spotRef.get(group) ?? group) : group;
    const r = await tm.priceHistory({ symbol, window: "15m", resolution: "1m", asOf: at.toISOString(), ...(cls === "perp" ? { assetClass: cls } : {}) });
    return r.points?.at(-1)?.price ?? null;
  },
});

let running = false;
async function tick() {
  if (running) return;
  running = true;
  const now = new Date();
  try {
    await stream.refreshStale();
    const b = await bell.tick(BELL_WATCHLIST, now);
    for (const symbol of b.snapshotsTaken) {
      await logDecision(db, {
        userId: null,
        engineVersion: ENGINE_VERSION,
        action: "bell_snapshot",
        explanation: `Recorded ${symbol} close and perp mark for the ${b.closure!.kind} closure (${b.closure!.closeAt.toISOString()} → ${b.closure!.openAt.toISOString()}).`,
        inputs: { symbol, closeAt: b.closure!.closeAt },
        outputs: {},
      });
    }
    if (b.closure && b.estimates.length) {
      await publish(db, { type: "bell", data: { closure: b.closure, estimates: b.estimates } });
    }
  } catch (e) {
    log.error({ error: String(e) }, "tick_failed");
  } finally {
    running = false;
  }
}

const timer = setInterval(tick, TICK_MS);
void tick();
log.info({ tickMs: TICK_MS, spot: Object.fromEntries(spotRef), orgMode: Boolean(tokens) }, "worker started");

async function shutdown() {
  clearInterval(timer);
  stream.stop();
  await sql.end({ timeout: 5 });
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
