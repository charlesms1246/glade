import type { TmUserRecord } from "../onboarding/onboard";

export interface OnboardingJobDeps {
  /** App users that have no Gateway user yet, oldest first. */
  pending: (limit: number) => Promise<{ id: string }[]>;
  onboard: (userId: string) => Promise<TmUserRecord>;
  /** Credit the user's paper account (no real money). Called once per newly onboarded user. */
  fundPaper: (userId: string) => Promise<void>;
  record: (userId: string, rec: TmUserRecord) => Promise<void>;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

/** Onboards a few users per tick. One user's failure never blocks the others; it is retried next tick. */
export async function runOnboardingJob(deps: OnboardingJobDeps, limit = 5): Promise<{ done: string[]; failed: string[] }> {
  const done: string[] = [];
  const failed: string[] = [];
  for (const { id } of await deps.pending(limit)) {
    try {
      const rec = await deps.onboard(id);
      await deps.fundPaper(id);
      await deps.record(id, rec);
      done.push(id);
    } catch (e) {
      failed.push(id);
      deps.log?.("onboarding_failed", { userId: id, error: String(e).slice(0, 300) });
    }
  }
  return { done, failed };
}
