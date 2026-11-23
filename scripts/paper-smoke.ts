// PAPER smoke test of the Postgres repo: a throwaway user opens and closes a simulated short at fixed
// prices. Everything runs inside one transaction that is always rolled back, so the throwaway user is
// never visible to other connections (the worker never onboards it). No real funds, no True Markets calls.
//   pnpm exec tsx scripts/paper-smoke.ts
import { existsSync } from "node:fs";
import { createDb, schema, type Db } from "@glade/db";
import { createPaperVenue, drizzlePaperRepo, usersWithoutPaperAccount, type PaperAsset } from "@glade/paper";
import { dec, loadEnv } from "@glade/shared";
import { generateSignerKeyPair, stampPayload } from "@glade/stamp";

if (existsSync(".env")) process.loadEnvFile(".env");
const env = loadEnv();
const { db, sql } = createDb(env.DATABASE_URL, { max: 1 });
const asset: PaperAsset = { assetId: "paper-smoke-perp", symbol: "SMOKE", type: "perp", assetClass: "stock", maxLeverage: 5, economicAssetId: null, venue: "paper", chain: null };
const signer = generateSignerKeyPair();
let price = "100";

const check = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAILED: ${what}`);
  console.log(`ok  ${what}`);
};

class Rollback extends Error {}

try {
  await db.transaction(async (outer) => {
    // Nested transactions in the repo become savepoints of this one.
    const tx = outer as unknown as Db;
    const [user] = await tx.insert(schema.appUsers).values({ displayName: `paper-smoke-${Date.now()}` }).returning();
    const uid = user!.id;
    await tx.insert(schema.signerKeys).values({ userId: uid, env: "uat", publicKeyHex: signer.publicKeyHex, encPrivateKey: "-", encDataKey: "-", iv: "-", dataKeyIv: "-", alg: "none" });
    const venue = createPaperVenue({ repo: drizzlePaperRepo(tx), prices: async () => dec(price), registry: async (id) => (id === asset.assetId ? asset : null) });
    check((await usersWithoutPaperAccount(tx, 10_000)).includes(uid), "new user listed as needing a paper account");
    check((await venue.ensurePaperAccount(uid, "1000")) === true, "ensurePaperAccount creates the account");
    check((await venue.ensurePaperAccount(uid, "1000")) === false, "a second ensurePaperAccount is a no-op");
    check(!(await usersWithoutPaperAccount(tx, 10_000)).includes(uid), "user no longer listed");
    const u = venue.forUser(uid);
    const o = await u.createOrder({ asset_id: asset.assetId, side: "sell", type: "market", qty: "1", qty_unit: "base", leverage: 2, venue: "defi" });
    await u.executeOrder(o.order_id!, [stampPayload(o.payloads![0]!.payload, signer)]);
    check((await u.getOrder(o.order_id!)).status === "complete", "short filled");
    const again = await u.executeOrder(o.order_id!, [stampPayload(o.payloads![0]!.payload, signer)]).then(() => "ok", (e: { code?: string }) => e.code);
    check(again === "already_submitted", "second execute is 409 already_submitted");
    price = "90";
    const c = await u.createOrder({ asset_id: asset.assetId, side: "buy", type: "market", qty: "1", qty_unit: "base", reduce_only: true, venue: "defi" });
    await u.executeOrder(c.order_id!, [stampPayload(c.payloads![0]!.payload, signer)]);
    const p = await u.portfolio();
    // 1000 − 50 margin − 0.045 fee + 50 + 10 pnl − 0.0405 fee
    check(p.cash_usd === "1009.9145" && p.positions.length === 0, `closed with pnl; cash ${p.cash_usd}`);
    throw new Rollback();
  });
} catch (e) {
  if (!(e instanceof Rollback)) throw e;
  console.log("rolled back: nothing was persisted");
} finally {
  await sql.end();
}
