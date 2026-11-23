// NYSE full-day holidays and 13:00 ET early closes.
// Must be verified against the official ICE/NYSE holiday calendar before relying on it.
// Assumption: no early close on 2026-07-02 or 2027-07-02, because Independence Day is
// observed on the adjacent weekday (Jul 3 2026, Jul 5 2027), matching past practice.
export const HOLIDAYS: ReadonlySet<string> = new Set([
  // 2026
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
  "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  // 2027
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31",
  "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
]);

export const EARLY_CLOSES: ReadonlySet<string> = new Set([
  "2026-11-27", "2026-12-24",
  "2027-11-26",
]);

export const COVERED_YEARS = [2026, 2027] as const;
