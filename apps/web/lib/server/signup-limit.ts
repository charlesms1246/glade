import "server-only";
import { fail } from "./api";
import { clientIp, slidingWindow } from "./rate-limit";

const HOUR = 3_600_000;
const g = globalThis as unknown as { __gladeSignup?: Record<string, ReturnType<typeof slidingWindow>> };
g.__gladeSignup ??= { options: slidingWindow(5, HOUR), verify: slidingWindow(5, HOUR) };

/** A 429 response when this IP has started too many sign-ups this hour, else null. */
export function signupLimited(step: "options" | "verify", req: Request): Response | null {
  return g.__gladeSignup![step]!.allow(clientIp(req)) ? null : fail(429, "Too many sign-ups from this network. Try again in an hour.");
}
