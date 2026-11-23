const nyFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** New York wall-clock parts for an instant. */
export function nyParts(at: Date): { ymd: string; hour: number; minute: number; weekday: number } {
  const p = Object.fromEntries(nyFmt.formatToParts(at).map((x) => [x.type, x.value]));
  const ymd = `${p.year}-${p.month}-${p.day}`;
  return {
    ymd,
    hour: Number(p.hour),
    minute: Number(p.minute),
    weekday: new Date(`${ymd}T00:00:00Z`).getUTCDay(),
  };
}

/** Offset (ms) of New York local time from UTC at a given instant. */
function nyOffsetMs(at: Date): number {
  const p = Object.fromEntries(nyFmt.formatToParts(at).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!);
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** Convert a New York wall-clock date and time to the UTC instant. */
export function nyToUtc(ymd: string, hour: number, minute: number): Date {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d, hour, minute);
  // Two passes settle the offset across DST transitions.
  let t = guess - nyOffsetMs(new Date(guess));
  t = guess - nyOffsetMs(new Date(t));
  return new Date(t);
}

/** Add whole days to a YYYY-MM-DD date. */
export function addDays(ymd: string, days: number): string {
  const t = new Date(`${ymd}T00:00:00Z`).getTime() + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}
