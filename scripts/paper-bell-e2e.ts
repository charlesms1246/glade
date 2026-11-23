// End-to-end PAPER test of "Shield until the bell" in the worker (no real money). A software passkey
// approves a plan with an open leg and its reduce-only close; the worker verifies the approval, opens
// the short, then at unwind_at closes it with the approved close leg and marks the hedge closed. A
// replay of the same approval is refused.
//   pnpm exec tsx scripts/paper-bell-e2e.ts --name demo-1
import { existsSync, readFileSync } from "node:fs";
import { createDb, schema } from "@glade/db";
import { createPaperVenue, drizzlePaperRepo, drizzleRegistry } from "@glade/paper";
import { dec, loadEnv, planChallenge, planHash, TM_BASE_URLS } from "@glade/shared";
import { apiKeyMinter, createTmClient, TokenManager, type OrgKey } from "@glade/tm-client";
import { and, desc, eq } from "drizzle-orm";
import pino from "pino";
import { loadBellSigma } from "../apps/worker/src/config";
import { PriceCache } from "../apps/worker/src/market/price-cache";
import { MarketStream } from "../apps/worker/src/market/stream";
import { startTrading } from "../apps/worker/src/trading";
import { createSoftPasskey } from "./lib/soft-passkey";

if (existsSync(".env")) process.loadEnvFile(".env");
const env = loadEnv();
const i = process.argv.indexOf("--name");
const name = i === -1 ? "demo-1" : process.argv[i + 1]!;
const urls = TM_BASE_URLS[env.TM_ENV];
const { db, sql } = createDb(env.DATABASE_URL, { max: 4 });
const tokens = new TokenManager(apiKeyMinter({ restBase: urls.rest, key: JSON.parse(readFileSync(env.TM_ORG_KEY_FILE, "utf8")) as OrgKey }));
const tm = createTmClient({ restBase: urls.rest, tokens });
const cache = new PriceCache();
const stream = new MarketStream({ url: urls.ws, cache, tm });
stream.start();
const stop = startTrading({ db, tm, tokens, env, cache, stream, log: pino({ level: "warn" }), sigma: loadBellSigma("docs/evidence/bell-calibration-NVDA.json") });

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
if (!user) throw new Error(`no app user ${name}`);
const uid = user.id;
const [perp] = await db.select().from(schema.assetRegistry).where(and(eq(schema.assetRegistry.env, env.TM_ENV), eq(schema.assetRegistry.type, "perp"), eq(schema.assetRegistry.symbol, "NVDA")));
const mark = dec((await tm.prices("NVDA", "perp")).candles![0]!.closePrice!);
const venue = createPaperVenue({ repo: drizzlePaperRepo(db), prices: async () => mark, registry: drizzleRegistry(db, env.TM_ENV) });
const passkey = createSoftPasskey(env.WEBAUTHN_RP_ID, env.APP_ORIGIN);
await db.insert(schema.passkeys).values({ userId: uid, credentialId: passkey.credentialId, publicKey: passkey.cosePublicKey, counter: 0 });

const shortBefore = dec((await venue.forUser(uid).positions()).positions.find((p) => p.asset_id === perp!.assetId)?.size ?? "0");
let hedgeId = "";
try {
  const qty = "0.5";
  const notionalUsd = mark.mul(qty).toFixed(2);
  const unwindAt = new Date(Date.now() + 20_000);
  const plan = {
    kind: "bell",
    userId: uid,
    unwindAt: unwindAt.toISOString(),
    assetIds: [perp!.assetId],
    estimates: [{ symbol: "NVDA", close: mark.toString(), impliedOpen: mark.toString(), gap: "0", band: "0.02" }],
    legs: [
      { assetId: perp!.assetId, symbol: "NVDA", side: "sell", qty, qtyUnit: "base", leverage: "2", reduceOnly: false, notionalUsd, beta: "1" },
      { assetId: perp!.assetId, symbol: "NVDA", side: "buy", qty, qtyUnit: "base", reduceOnly: true, notionalUsd, beta: "1" },
    ],
  };
  const hash = planHash(plan);
  const assertion = passkey.assert(planChallenge(hash));
  const inputs = { plan, planHash: hash, notionalUsd, source: "user", assertion, credentialId: passkey.credentialId };
  const [h] = await db.insert(schema.hedges).values({ userId: uid, mode: "bell", status: "planned", legs: plan.legs, unwindAt }).returning();
  hedgeId = h!.id;
  const openIntent = { userId: uid, hedgeId, kind: "open" as const, assetId: perp!.assetId, side: "sell" as const, qty, qtyUnit: "base", leverage: "2", reduceOnly: false, planHash: hash, reason: "Shield until the bell (paper e2e).", inputs };
  await db.insert(schema.intents).values(openIntent);

  await until("passkey-approved open filled; hedge active", async () => {
    const [x] = await db.select().from(schema.hedges).where(eq(schema.hedges.id, hedgeId));
    return x?.status === "active" ? x : null;
  });

  // Replay: the same approval inserted again must be refused by the worker.
  const [replay] = await db.insert(schema.intents).values(openIntent).returning();
  const refused = await until("replayed approval refused", async () => {
    const [x] = await db.select().from(schema.intents).where(eq(schema.intents.id, replay!.id));
    return x?.status === "rejected" ? x : null;
  });
  void refused;

  await until("unwound at unwind_at; hedge closed", async () => {
    const [x] = await db.select().from(schema.hedges).where(eq(schema.hedges.id, hedgeId));
    return x?.status === "closed" ? x : null;
  }, 120_000);
  const shortAfter = dec((await venue.forUser(uid).positions()).positions.find((p) => p.asset_id === perp!.assetId)?.size ?? "0");
  console.log(`     short before ${shortBefore}, after ${shortAfter} (unchanged: ${shortAfter.eq(shortBefore)})`);
  const log = await db.select().from(schema.decisions).where(eq(schema.decisions.userId, uid)).orderBy(desc(schema.decisions.at)).limit(3);
  for (const d of log.reverse()) console.log(`  ${d.action.padEnd(16)} ${d.explanation}`);
} finally {
  await db.delete(schema.passkeys).where(eq(schema.passkeys.credentialId, passkey.credentialId));
  stop();
  stream.stop();
  await sql.end({ timeout: 5 });
}
