// Spike: which product types and asset classes True Markets allows from this machine's IP. Read-only.
// Run it from every place the worker might be hosted.
//   pnpm exec tsx scripts/spike-availability.ts
import { existsSync, readFileSync } from "node:fs";
import { loadEnv, TM_BASE_URLS } from "@glade/shared";
import { apiKeyMinter, createTmClient, TokenManager, type OrgKey } from "@glade/tm-client";

if (existsSync(".env")) process.loadEnvFile(".env");
const env = loadEnv();
const restBase = TM_BASE_URLS[env.TM_ENV].rest;
const key = JSON.parse(readFileSync(env.TM_ORG_KEY_FILE, "utf8")) as OrgKey;
const tokens = new TokenManager(apiKeyMinter({ restBase, key }));

for (const [label, client] of [
  ["anonymous", createTmClient({ restBase })],
  ["org token", createTmClient({ restBase, tokens })],
] as const) {
  const a = await client.availability();
  const perps = a.allowed_product_types.includes("perp");
  const stocks = a.allowed_asset_classes.includes("stock");
  console.log(`${label.padEnd(10)} country=${a.country} products=[${a.allowed_product_types}] classes=[${a.allowed_asset_classes}] → perps ${perps ? "OK" : "BLOCKED"}, stocks ${stocks ? "OK" : "BLOCKED"}`);
}
