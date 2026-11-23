import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { currentClosure, isOpen, nextClose, nextOpen, sessionFor } from "./calendar";

const iso = (d: Date) => d.toISOString();

describe("sessions around Thanksgiving 2026", () => {
  it("Wed 2026-11-25 closes 21:00Z", () => {
    expect(iso(sessionFor("2026-11-25")!.close)).toBe("2026-11-25T21:00:00.000Z");
  });
  it("Thu 2026-11-26 is closed", () => {
    expect(sessionFor("2026-11-26")).toBeNull();
  });
  it("Fri 2026-11-27 opens 14:30Z and closes early 18:00Z", () => {
    const s = sessionFor("2026-11-27")!;
    expect(iso(s.open)).toBe("2026-11-27T14:30:00.000Z");
    expect(iso(s.close)).toBe("2026-11-27T18:00:00.000Z");
    expect(s.early).toBe(true);
  });
  it("next open after Wed close is Fri 14:30Z, as a holiday closure", () => {
    const now = new Date("2026-11-25T21:00:00Z");
    expect(iso(nextOpen(now))).toBe("2026-11-27T14:30:00.000Z");
    const c = currentClosure(now)!;
    expect(c.kind).toBe("holiday");
    expect(iso(c.closeAt)).toBe("2026-11-25T21:00:00.000Z");
    expect(iso(c.openAt)).toBe("2026-11-27T14:30:00.000Z");
  });
  it("next close from Fri morning is the early close", () => {
    expect(iso(nextClose(new Date("2026-11-27T10:00:00Z")))).toBe("2026-11-27T18:00:00.000Z");
  });
});

describe("DST and closure kinds", () => {
  it("summer session uses EDT (13:30Z open)", () => {
    const s = sessionFor("2026-07-01")!;
    expect(iso(s.open)).toBe("2026-07-01T13:30:00.000Z");
    expect(iso(s.close)).toBe("2026-07-01T20:00:00.000Z");
  });
  it("weekend closure", () => {
    const c = currentClosure(new Date("2026-11-28T12:00:00Z"))!;
    expect(c.kind).toBe("weekend");
    expect(iso(c.closeAt)).toBe("2026-11-27T18:00:00.000Z");
    expect(iso(c.openAt)).toBe("2026-11-30T14:30:00.000Z");
  });
  it("overnight closure", () => {
    const c = currentClosure(new Date("2026-11-24T02:00:00Z"))!;
    expect(c.kind).toBe("overnight");
    expect(iso(c.openAt)).toBe("2026-11-24T14:30:00.000Z");
  });
  it("open market has no closure", () => {
    const now = new Date("2026-11-24T15:00:00Z");
    expect(isOpen(now)).toBe(true);
    expect(currentClosure(now)).toBeNull();
  });
});

describe("properties", () => {
  it("nextOpen is after now and is an open instant", () => {
    const lo = Date.parse("2026-01-02T00:00:00Z");
    const hi = Date.parse("2027-12-01T00:00:00Z");
    fc.assert(
      fc.property(fc.integer({ min: lo, max: hi }), (t) => {
        const now = new Date(t);
        const o = nextOpen(now);
        return o > now && isOpen(o) && !isOpen(new Date(o.getTime() - 1));
      }),
      { numRuns: 300 },
    );
  });
});
