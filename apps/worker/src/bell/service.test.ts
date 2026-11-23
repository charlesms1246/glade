import { dec } from "@glade/shared";
import { describe, expect, it } from "vitest";
import { PriceCache } from "../market/price-cache";
import { createBellService, memoryBellRepo, type PriceBefore } from "./service";

const sigma = { overnight: dec("0.0232"), weekend: dec("0.0914"), holiday: dec("0.0914") };
const closeWed = new Date("2026-11-25T21:00:00Z");

function setup() {
  const repo = memoryBellRepo();
  const cache = new PriceCache();
  const asked: string[] = [];
  const priceBefore: PriceBefore = async (sym, cls, at) => {
    asked.push(`${sym}:${cls}:${at.toISOString()}`);
    return cls === "spot" ? "100" : "101";
  };
  const bell = createBellService({ repo, cache, priceBefore, sigma });
  return { repo, cache, bell, asked };
}

describe("Bell service", () => {
  it("does nothing while the market is open", async () => {
    const t = setup();
    const r = await t.bell.tick(["NVDA"], new Date("2026-11-25T18:00:00Z"));
    expect(r.closure).toBeNull();
    expect(t.repo.sessions.size).toBe(0);
  });

  it("snapshots the Thanksgiving close once, from prices before 21:00Z", async () => {
    const t = setup();
    await t.bell.tick(["NVDA"], new Date("2026-11-25T21:00:30Z")); // inside settle window
    expect(t.repo.snaps.size).toBe(0);
    const r = await t.bell.tick(["NVDA"], new Date("2026-11-25T21:02:00Z"));
    expect(r.closure).toMatchObject({ kind: "holiday", openAt: new Date("2026-11-27T14:30:00Z") });
    expect(r.snapshotsTaken).toEqual(["NVDA"]);
    expect(t.asked).toEqual([`NVDA:spot:${closeWed.toISOString()}`, `NVDA:perp:${closeWed.toISOString()}`]);
    const again = await t.bell.tick(["NVDA"], new Date("2026-11-26T03:00:00Z"));
    expect(again.snapshotsTaken).toEqual([]);
    expect(t.asked).toHaveLength(2);
    expect(t.repo.snaps.get(closeWed.toISOString())![0]).toMatchObject({ closePx: "100", markPx: "101", basis: "0.01" });
  });

  it("estimates the implied open from a fresh perp mark, with the holiday band", async () => {
    const t = setup();
    const now = new Date("2026-11-26T12:00:00Z");
    t.cache.set("NVDA", "perp", "106.05", new Date(now.getTime() - 5_000), "ws");
    const r = await t.bell.tick(["NVDA"], now);
    expect(r.estimates).toHaveLength(1);
    // implied = 106.05 / 1.01 = 105 → +5% vs close 100
    expect(r.estimates[0]).toMatchObject({ impliedOpen: "105.0000", gap: "0.050000", band: "0.091400" });
  });

  it("skips estimates when the mark is stale", async () => {
    const t = setup();
    const now = new Date("2026-11-26T12:00:00Z");
    t.cache.set("NVDA", "perp", "106", new Date(now.getTime() - 120_000), "ws");
    expect((await t.bell.tick(["NVDA"], now)).estimates).toEqual([]);
  });

  it("uses the overnight band on a normal weeknight", async () => {
    const t = setup();
    const now = new Date("2026-11-24T23:00:00Z");
    t.cache.set("NVDA", "perp", "101", now, "ws");
    const r = await t.bell.tick(["NVDA"], now);
    expect(r.closure?.kind).toBe("overnight");
    expect(r.estimates[0]!.band).toBe("0.023200");
    expect(r.estimates[0]!.gap).toBe("0.000000");
  });
});
