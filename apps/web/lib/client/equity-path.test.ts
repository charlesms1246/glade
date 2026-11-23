import { describe, expect, it } from "vitest";
import { equityPaths } from "./equity-path";

const p = (at: string, equityUsd: string, floorUsd: string | null = null) => ({ at, equityUsd, floorUsd });

describe("equityPaths", () => {
  it("needs at least two points", () => {
    expect(equityPaths([], 100, 50)).toBeNull();
    expect(equityPaths([p("2026-11-24T00:00:00Z", "100")], 100, 50)).toBeNull();
  });

  it("spans the box in time and keeps every point inside it", () => {
    const r = equityPaths([p("2026-11-24T00:00:00Z", "100"), p("2026-11-24T00:15:00Z", "110"), p("2026-11-24T00:30:00Z", "105")], 300, 100)!;
    const coords = [...r.equity.matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
    expect(coords[0]![0]).toBe(0);
    expect(coords.at(-1)![0]).toBe(300);
    for (const [, yv] of coords) {
      expect(yv).toBeGreaterThanOrEqual(0);
      expect(yv).toBeLessThanOrEqual(100);
    }
    expect(r.floor).toBe("");
  });

  it("breaks the target line where no mandate was active", () => {
    const r = equityPaths(
      [p("2026-11-24T00:00:00Z", "100", "90"), p("2026-11-24T00:15:00Z", "100", null), p("2026-11-24T00:30:00Z", "100", "91"), p("2026-11-24T00:45:00Z", "100", "92")],
      300,
      100,
    )!;
    expect(r.floor.match(/M/g)).toHaveLength(2);
  });
});
