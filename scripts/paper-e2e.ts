// End-to-end PAPER test of the worker's trading wiring for one user (no real money; production orders
// are refused in code). Onboards/funds the paper account, buys paper stock, signs a Floor mandate with a
// software passkey, waits for the worker to open a short perp hedge, checks that an edited mandate stops
// automation, signs a looser mandate, waits for the reduce-only close, then revokes the mandate.
//   pnpm exec tsx scripts/paper-e2e.ts --name demo-1
import { existsSync, readFileSync } from "node:fs";
import { createDb, schema } from "@glade/db";
import { createPaperVenue, drizzlePaperRepo, drizzleRegistry } from "@glade/paper";
import { mandateHash, type MandateTerms } from "@glade/engine";
import { dec, loadEnv, planChallenge, TM_BASE_URLS } from "@glade/shared";
import { parseMasterKey, stampPayload } from "@glade/stamp";
import { apiKeyMinter, createTmClient, TokenManager, type OrgKey } from "@glade/tm-client";
import { and, desc, eq } from "drizzle-orm";
import pino from "pino";
import { onboardingRepo } from "../apps/worker/src/db/repos";
import { PriceCache } from "../apps/worker/src/market/price-cache";
import { loadBellSigma } from "../apps/worker/src/config";
import { MarketStream } from "../apps/worker/src/market/stream";
import { loadSigner } from "../apps/worker/src/onboarding/onboard";
import { startTrading } from "../apps/worker/src/trading";
import { createSoftPasskey } from "./lib/soft-passkey";

if (existsSync(".env")) process.loadEnvFile(".env");
const env = { ...loadEnv(), FLOOR_COOLDOWN_SEC: 1 };
const i = process.argv.indexOf("--name");
const name = i === -1 ? "demo-1" : process.argv[i + 1]!;
const urls = TM_BASE_URLS[env.TM_ENV];
const log = pino({ level: "warn" });
const { db, sql } = createDb(env.DATABASE_URL, { max: 4 });
const tokens = new TokenManager(apiKeyMinter({ restBase: urls.rest, key: JSON.parse(readFileSync(env.TM_ORG_KEY_FILE, "utf8")) as OrgKey }));
const tm = createTmClient({ restBase: urls.rest, tokens });
const cache = new PriceCache();
const stream = new MarketStream({ url: urls.ws, cache, tm });
stream.start();
const sigma = loadBellSigma("docs/evidence/bell-calibration-NVDA.json");
const stop = startTrading({ db, tm, tokens, env, cache, stream, log, sigma });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(label: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 90_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) {
      console.log(`ok   ${label} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
      return v;
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout: ${label}`);
    await sleep(1000);
  }
}

const [user] = await db.select().from(schema.appUsers).where(eq(schema.appUsers.displayName, name));
if (!user) throw new Error(`no app user ${name}; run scripts/spike-user.ts first`);
const uid = user.id;
const reg = schema.assetRegistry;
const find = async (symbol: string, type: "spot" | "perp") =>
  (await db.select().from(reg).where(and(eq(reg.env, env.TM_ENV), eq(reg.symbol, symbol), eq(reg.type, type))))[0]!;
const nvdaSpot = await find("NVDA", "spot");
const nvdaPerp = await find("NVDA", "perp");

const prices = async (symbol: string, cls: "spot" | "perp") => {
  const r = await tm.prices(symbol, cls);
  return dec(r.candles?.find((c) => c.interval === "1h")?.closePrice ?? r.candles![0]!.closePrice!);
};
const venue = createPaperVenue({ repo: drizzlePaperRepo(db), prices, registry: drizzleRegistry(db, env.TM_ENV) });
const me = venue.forUser(uid);

try {
  await until("paper account funded by the onboarding job", async () => {
    const p = await me.portfolio().catch(() => null);
    return p && dec(p.cash_usd ?? "0").gt(0) ? p : null;
  });

  const held = (await me.portfolio()).balances.find((b) => b.symbol === "NVDA" && !b.stable);
  if (!held) {
    const signer = await loadSigner(onboardingRepo(db), parseMasterKey(env.SIGNER_MASTER_KEY), uid);
    const o = await me.createOrder({ asset_id: nvdaSpot.assetId, side: "buy", type: "market", qty: "800", qty_unit: "quote", venue: "defi" });
    await me.executeOrder(o.order_id!, (o.payloads ?? []).map((p) => stampPayload(p.payload, signer)));
    console.log(`ok   paper NVDA buy: ${JSON.stringify(await me.getOrder(o.order_id!)).slice(0, 160)}`);
  }

  const p0 = await me.portfolio();
  console.log(`     equity ${p0.total_usd}, cash ${p0.cash_usd}`);

  // A software passkey stands in for the user's device; the worker verifies its signature like a real one.
  const passkey = createSoftPasskey(env.WEBAUTHN_RP_ID, env.APP_ORIGIN);
  await db.insert(schema.passkeys).values({ userId: uid, credentialId: passkey.credentialId, publicKey: passkey.cosePublicKey, counter: 0 });

  const revokeActive = () =>
    db.update(schema.mandates).set({ status: "revoked", revokedAt: new Date() }).where(and(eq(schema.mandates.userId, uid), eq(schema.mandates.status, "active")));
  const signMandate = async (floorPct: string) => {
    await revokeActive();
    await db.delete(schema.floorState).where(eq(schema.floorState.userId, uid));
    const [last] = await db.select({ v: schema.mandates.version }).from(schema.mandates).where(eq(schema.mandates.userId, uid)).orderBy(desc(schema.mandates.version)).limit(1);
    const terms = {
      userId: uid,
      version: (last?.v ?? 0) + 1,
      floorPct,
      multiplier: "4",
      ratchet: false,
      baseUsd: dec(p0.total_usd!).toDecimalPlaces(2).toString(),
      leverageMax: "3",
      allowedPerps: [nvdaPerp.assetId],
      maxTradesDay: 20,
    } satisfies MandateTerms;
    const hash = mandateHash(terms);
    const [m] = await db
      .insert(schema.mandates)
      .values({ ...terms, status: "active", mandateHash: hash, webauthnAssertion: { assertion: passkey.assert(planChallenge(hash)), credentialId: passkey.credentialId }, signedAt: new Date() })
      .returning();
    return m!;
  };

  // Floor at 99.5% of current equity: almost no cushion, so the worker should hedge most of the stock.
  const m1 = await signMandate("0.995");
  const opened = await until("Floor opened a short NVDA perp hedge under a passkey-signed mandate", async () =>
    (await me.positions()).positions.find((x) => x.asset_id === nvdaPerp.assetId && x.side === "short"),
  );
  console.log(`     short ${opened.size} @ ${opened.entry_price}, margin ${opened.margin_used}, liq ${opened.liquidation_price}`);

  // Tamper: loosen the signed mandate in the database. The worker must refuse to act on it.
  await db.update(schema.mandates).set({ floorPct: "0.5" }).where(eq(schema.mandates.id, m1.id));
  await db.update(schema.floorState).set({ lastTradeAt: null }).where(eq(schema.floorState.userId, uid));
  await until("edited mandate refused by policy", async () => {
    const [d] = await db.select().from(schema.decisions).where(and(eq(schema.decisions.userId, uid), eq(schema.decisions.action, "intent_rejected"))).orderBy(desc(schema.decisions.at)).limit(1);
    return d && d.explanation.includes("no active mandate") ? d : null;
  });
  const stillOpen = (await me.positions()).positions.find((x) => x.asset_id === nvdaPerp.assetId && dec(x.size ?? "0").gt(0));
  console.log(`     position untouched after tamper: ${stillOpen?.size === opened.size}`);

  // A properly signed looser mandate: the worker closes the hedge.
  const m2 = await signMandate("0.5");
  await until("Floor closed the hedge with a reduce-only buy", async () => !(await me.positions()).positions.some((x) => x.asset_id === nvdaPerp.assetId && dec(x.size ?? "0").gt(0)));

  await db.update(schema.mandates).set({ status: "revoked", revokedAt: new Date() }).where(eq(schema.mandates.id, m2.id));
  await db.delete(schema.passkeys).where(eq(schema.passkeys.credentialId, passkey.credentialId));
  const log_ = await db.select().from(schema.decisions).where(eq(schema.decisions.userId, uid)).orderBy(desc(schema.decisions.at)).limit(8);
  console.log("activity log:");
  for (const d of log_.reverse()) console.log(`  ${d.action.padEnd(17)} ${d.explanation}`);
  const p1 = await me.portfolio();
  console.log(`     final equity ${p1.total_usd}, cash ${p1.cash_usd}; mandate revoked`);
} finally {
  stop();
  stream.stop();
  await sql.end({ timeout: 5 });
}
