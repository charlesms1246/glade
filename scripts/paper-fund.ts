// PAPER deposit: credits simulated USDC to a user's paper account. No real funds, no True Markets calls.
//   pnpm exec tsx scripts/paper-fund.ts --name demo-1 --usd 10000
import { existsSync } from "node:fs";
import { createDb, schema } from "@glade/db";
import { createPaperVenue, drizzlePaperRepo } from "@glade/paper";
import { dec, loadEnv } from "@glade/shared";
import { eq } from "drizzle-orm";

if (existsSync(".env")) process.loadEnvFile(".env");
const env = loadEnv();
const arg = (k: string) => {
  const i = process.argv.indexOf(k);
  return i === -1 ? undefined : process.argv[i + 1];
};
const name = arg("--name") ?? "demo-1";
const usd = arg("--usd") ?? "10000";
if (!dec(usd).isFinite() || dec(usd).lte(0)) throw new Error("--usd must be a positive amount");

const { db, sql } = createDb(env.DATABASE_URL, { max: 2 });
try {
  const [user] = await db.select().from(schema.appUsers).where(eq(schema.appUsers.displayName, name));
  if (!user) throw new Error(`no app user named ${name}`);
  const venue = createPaperVenue({
    repo: drizzlePaperRepo(db),
    prices: async () => {
      throw new Error("prices are not needed for a paper deposit");
    },
    registry: async () => null,
  });
  const cash = await venue.fundPaper(user.id, usd);
  console.log(`PAPER deposit of ${usd} USDC to ${name} (${user.id}); paper cash now ${cash}`);
} finally {
  await sql.end();
}
