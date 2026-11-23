// Spike: onboard one demo Glade user. Creates (or reuses) a Gateway user in the organization with a
// per-user signer key, then prints the deposit addresses. Idempotent on --name. Moves no funds.
//   pnpm exec tsx scripts/spike-user.ts --name demo-1
import { readFileSync } from "node:fs";
import { createDb, schema } from "@glade/db";
import { loadEnv, TM_BASE_URLS } from "@glade/shared";
import { parseMasterKey } from "@glade/stamp";
import { apiKeyMinter, createTmClient, TokenManager, type OrgKey } from "@glade/tm-client";
import { eq } from "drizzle-orm";
import { onboardingRepo } from "../apps/worker/src/db/repos";
import { onboardUser } from "../apps/worker/src/onboarding/onboard";

process.loadEnvFile(".env");
const env = loadEnv();
const i = process.argv.indexOf("--name");
const name = i === -1 ? "demo-1" : process.argv[i + 1]!;

const restBase = TM_BASE_URLS[env.TM_ENV].rest;
const key = JSON.parse(readFileSync(env.TM_ORG_KEY_FILE, "utf8")) as OrgKey;
const tm = createTmClient({ restBase, tokens: new TokenManager(apiKeyMinter({ restBase, key })) });
const { db, sql } = createDb(env.DATABASE_URL, { max: 2 });

let [user] = await db.select().from(schema.appUsers).where(eq(schema.appUsers.displayName, name));
if (!user) [user] = await db.insert(schema.appUsers).values({ displayName: name }).returning();

const t0 = Date.now();
const rec = await onboardUser({ tm, repo: onboardingRepo(db), masterKey: parseMasterKey(env.SIGNER_MASTER_KEY), env: env.TM_ENV }, user!.id);
console.log(`user ${name} (${user!.id}) → Gateway user ${rec.tmUserId} in ${Date.now() - t0} ms`);
console.log(`solana deposit address: ${rec.solanaAddress ?? "none"}`);
console.log(`evm deposit address:    ${rec.evmAddress ?? "none"}`);

const bal = await tm.forUser(rec.tmUserId).balances();
console.log(`balances: ${JSON.stringify(bal).slice(0, 300)}`);
await sql.end();
