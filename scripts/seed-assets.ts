// Loads the True Markets asset catalog into asset_registry for TM_ENV. Read-only against True Markets; idempotent.
//   pnpm seed:assets
import { createDb, schema } from "@glade/db";
import { loadEnv, TM_BASE_URLS } from "@glade/shared";
import { createTmClient, type AssetItem } from "@glade/tm-client";
import { sql } from "drizzle-orm";

process.loadEnvFile(".env");
const env = loadEnv();
const tm = createTmClient({ restBase: TM_BASE_URLS[env.TM_ENV].rest });
const { db, sql: conn } = createDb(env.DATABASE_URL, { max: 2 });

const [spot, stocks, perps] = await Promise.all([
  tm.listAssets(),
  tm.listAssets({ asset_class: "stock" }),
  tm.listAssets({ product_type: "perp" }),
]);

const byId = new Map<string, AssetItem>();
for (const a of [...spot, ...stocks, ...perps]) if (a.id && a.symbol) byId.set(a.id, a);

const rows = [...byId.values()].map((a) => ({
  env: env.TM_ENV,
  assetId: a.id!,
  economicAssetId: a.economic_asset_id ?? null,
  symbol: a.symbol!,
  name: a.name ?? null,
  chain: a.chain ?? null,
  venue: a.venue ?? null,
  type: a.type ?? "spot",
  assetClass: a.asset_class ?? null,
  maxLeverage: a.perp?.max_leverage ?? null,
  orderTypes: a.order_types,
  updatedAt: new Date(),
}));

const t = schema.assetRegistry;
for (let i = 0; i < rows.length; i += 500) {
  await db
    .insert(t)
    .values(rows.slice(i, i + 500))
    .onConflictDoUpdate({
      target: [t.env, t.assetId],
      set: {
        economicAssetId: sql`excluded.economic_asset_id`,
        symbol: sql`excluded.symbol`,
        name: sql`excluded.name`,
        chain: sql`excluded.chain`,
        venue: sql`excluded.venue`,
        type: sql`excluded.type`,
        assetClass: sql`excluded.asset_class`,
        maxLeverage: sql`excluded.max_leverage`,
        orderTypes: sql`excluded.order_types`,
        updatedAt: sql`excluded.updated_at`,
      },
    });
}

const perpRows = rows.filter((r) => r.type === "perp");
const want = ["NVDA", "TSLA", "AAPL", "SP500", "XYZ100", "SPCX"];
console.log(`env ${env.TM_ENV}: upserted ${rows.length} assets (spot ${spot.length}, stock ${stocks.length}, perp ${perps.length})`);
console.log(`key perps: ${want.map((s) => `${s}${perpRows.some((r) => r.symbol === s) ? `×${perpRows.find((r) => r.symbol === s)!.maxLeverage}` : " MISSING"}`).join("  ")}`);
await conn.end();
