import { EARLY_CLOSES, HOLIDAYS } from "./holidays";
import { addDays, nyParts, nyToUtc } from "./tz";

export interface Session {
  open: Date;
  close: Date;
  early: boolean;
}

export type ClosureKind = "overnight" | "weekend" | "holiday";

export interface Closure {
  closeAt: Date;
  openAt: Date;
  kind: ClosureKind;
}

const MAX_SCAN_DAYS = 15;

function isWeekend(ymd: string): boolean {
  const wd = new Date(`${ymd}T00:00:00Z`).getUTCDay();
  return wd === 0 || wd === 6;
}

/** The regular session for a New York trading date, or null if the market is closed that day. */
export function sessionFor(ymd: string): Session | null {
  if (isWeekend(ymd) || HOLIDAYS.has(ymd)) return null;
  const early = EARLY_CLOSES.has(ymd);
  return {
    open: nyToUtc(ymd, 9, 30),
    close: nyToUtc(ymd, early ? 13 : 16, 0),
    early,
  };
}

export function isOpen(now: Date): boolean {
  const s = sessionFor(nyParts(now).ymd);
  return !!s && now >= s.open && now < s.close;
}

/** First session open strictly after `now`. */
export function nextOpen(now: Date): Date {
  const today = nyParts(now).ymd;
  for (let i = 0; i <= MAX_SCAN_DAYS; i++) {
    const s = sessionFor(addDays(today, i));
    if (s && s.open > now) return s.open;
  }
  throw new Error("no session found in scan window");
}

/** First session close strictly after `now`. */
export function nextClose(now: Date): Date {
  const today = nyParts(now).ymd;
  for (let i = 0; i <= MAX_SCAN_DAYS; i++) {
    const s = sessionFor(addDays(today, i));
    if (s && s.close > now) return s.close;
  }
  throw new Error("no session found in scan window");
}

/** Last session close at or before `now`. */
function prevClose(now: Date): { close: Date; ymd: string } {
  const today = nyParts(now).ymd;
  for (let i = 0; i <= MAX_SCAN_DAYS; i++) {
    const ymd = addDays(today, -i);
    const s = sessionFor(ymd);
    if (s && s.close <= now) return { close: s.close, ymd };
  }
  throw new Error("no session found in scan window");
}

/** The closure `now` falls in, or null while the market is open. */
export function currentClosure(now: Date): Closure | null {
  if (isOpen(now)) return null;
  const { close, ymd } = prevClose(now);
  const openAt = nextOpen(now);
  let kind: ClosureKind = "overnight";
  for (let d = addDays(ymd, 1); d < nyParts(openAt).ymd; d = addDays(d, 1)) {
    if (HOLIDAYS.has(d)) {
      kind = "holiday";
      break;
    }
    if (isWeekend(d)) kind = "weekend";
  }
  return { closeAt: close, openAt, kind };
}
