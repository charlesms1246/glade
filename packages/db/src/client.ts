import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export function createDb(url: string, opts: { max?: number } = {}) {
  const sql = postgres(url, { max: opts.max ?? 5, prepare: false });
  return { db: drizzle(sql, { schema }), sql };
}

export type Db = ReturnType<typeof createDb>["db"];

/**
 * A single long-lived connection for session-level advisory locks. Pooled connections are recycled
 * (max_lifetime, idle timeout), which would silently release a lock held on them.
 */
export function createLockConnection(url: string) {
  return postgres(url, { max: 1, max_lifetime: 60 * 60 * 24 * 365, idle_timeout: 0, prepare: false });
}
