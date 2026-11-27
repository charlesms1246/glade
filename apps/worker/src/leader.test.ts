import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireLeaderLock, watchLeaderLock, type LockSql } from "./leader";

const fake = (rows: () => unknown[] | Promise<unknown[]>): LockSql => (() => Promise.resolve(rows())) as unknown as LockSql;

describe("leader lock", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it("reports whether the lock was acquired", async () => {
    expect(await acquireLeaderLock(fake(() => [{ locked: true }]))).toBe(true);
    expect(await acquireLeaderLock(fake(() => [{ locked: false }]))).toBe(false);
  });

  it("calls onLost once when the session no longer holds the lock", async () => {
    let held = true;
    const lost: string[] = [];
    const stop = watchLeaderLock(fake(() => (held ? [{ held: 1 }] : [])), (r) => lost.push(r), 1000);
    await vi.advanceTimersByTimeAsync(3000);
    expect(lost).toEqual([]);
    held = false;
    await vi.advanceTimersByTimeAsync(3000);
    expect(lost).toHaveLength(1);
    stop();
  });

  it("treats a failed check as lost", async () => {
    const lost: string[] = [];
    watchLeaderLock(fake(() => Promise.reject(new Error("connection closed"))), (r) => lost.push(r), 1000);
    await vi.advanceTimersByTimeAsync(1500);
    expect(lost[0]).toMatch(/check failed/);
  });
});
