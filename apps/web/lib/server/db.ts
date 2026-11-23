import "server-only";
import { createDb, type Db } from "@glade/db";

const g = globalThis as unknown as { __gladeDb?: Db };

/** One database handle per server process (survives dev hot reloads). */
export function db(): Db {
  if (!g.__gladeDb) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    g.__gladeDb = createDb(url, { max: 3 }).db;
  }
  return g.__gladeDb;
}

/** Environment of the asset registry and Gateway users. */
export const tmEnv = (): "uat" | "prod" => (process.env.TM_ENV === "uat" ? "uat" : "prod");
