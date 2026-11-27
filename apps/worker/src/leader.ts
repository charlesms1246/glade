/** The minimal query surface the leader lock needs (a postgres.js client satisfies it). */
export type LockSql = (strings: TemplateStringsArray, ...values: unknown[]) => PromiseLike<unknown[]>;

const LOCK_KEY = "glade-worker";

/** Takes the single-leader advisory lock on a dedicated connection. False when another worker holds it. */
export async function acquireLeaderLock(sql: LockSql): Promise<boolean> {
  const r = (await sql`select pg_try_advisory_lock(hashtext(${LOCK_KEY})) as locked`) as { locked: boolean }[];
  return Boolean(r[0]?.locked);
}

/** True while this session still holds the lock. A reconnect or server restart ends the session and the lock. */
export async function holdsLeaderLock(sql: LockSql): Promise<boolean> {
  const r = (await sql`select 1 as held from pg_locks where locktype = 'advisory' and pid = pg_backend_pid() and granted`) as unknown[];
  return r.length > 0;
}

/** Checks the lock periodically and calls `onLost` once if it is gone or cannot be confirmed. Returns a stop function. */
export function watchLeaderLock(sql: LockSql, onLost: (reason: string) => void, everyMs = 30_000): () => void {
  let lost = false;
  const timer = setInterval(async () => {
    if (lost) return;
    try {
      if (await holdsLeaderLock(sql)) return;
      lost = true;
      onLost("leader lock no longer held");
    } catch (e) {
      lost = true;
      onLost(`leader lock check failed: ${String(e).slice(0, 200)}`);
    }
  }, everyMs);
  return () => clearInterval(timer);
}
