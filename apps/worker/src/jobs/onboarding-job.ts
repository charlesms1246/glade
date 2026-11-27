import type { TmUserRecord } from "../onboarding/onboard";

export interface OnboardingJobDeps {
  /** Users missing a paper account, or (when `gatewayAllowed`) a Gateway user. Oldest first. */
  pending: (limit: number, includeGateway: boolean, exclude: string[]) => Promise<{ id: string }[]>;
  ensureSigner: (userId: string) => Promise<void>;
  /** Create the paper account if absent (no real money). Returns true when it was created now. */
  ensurePaper: (userId: string) => Promise<boolean>;
  /** Link a True Markets Gateway user. Best-effort: the org has a user limit. */
  createGateway: (userId: string) => Promise<TmUserRecord>;
  gatewayAllowed: () => boolean;
  /** Called when True Markets refuses new users; the caller backs off. */
  onGatewayRefused: (e: unknown) => void;
  isGatewayRefusal: (e: unknown) => boolean;
  /** New paper accounts left today; protects against sign-up floods. */
  paperBudget: () => number;
  record: (userId: string, event: "paper_ready" | "gateway_linked", rec?: TmUserRecord) => Promise<void>;
  /** When each user last failed. Failed users are left out of the work list until the backoff ends. */
  failedAt?: Map<string, number>;
  backoffMs?: number;
  now?: () => number;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

/** A user whose onboarding failed is skipped this long, so one bad account cannot block the queue. */
const FAILURE_BACKOFF_MS = 5 * 60_000;

/**
 * Paper-first onboarding: a signer key and a paper account make a user ready to trade on paper.
 * The True Markets Gateway user is linked when the organisation allows it; refusals never block paper.
 */
export async function runOnboardingJob(deps: OnboardingJobDeps, limit = 5): Promise<{ ready: string[]; linked: string[]; failed: string[] }> {
  const ready: string[] = [];
  const linked: string[] = [];
  const failed: string[] = [];
  const now = (deps.now ?? Date.now)();
  const backoff = deps.backoffMs ?? FAILURE_BACKOFF_MS;
  const exclude: string[] = [];
  for (const [id, at] of deps.failedAt ?? []) {
    if (now - at < backoff) exclude.push(id);
    else deps.failedAt?.delete(id);
  }
  for (const { id } of await deps.pending(limit, deps.gatewayAllowed(), exclude)) {
    try {
      await deps.ensureSigner(id);
      if (deps.paperBudget() > 0 && (await deps.ensurePaper(id))) {
        await deps.record(id, "paper_ready");
        ready.push(id);
      }
    } catch (e) {
      failed.push(id);
      deps.failedAt?.set(id, now);
      deps.log?.("onboarding_failed", { userId: id, error: String(e).slice(0, 300) });
      continue;
    }
    if (!deps.gatewayAllowed()) continue;
    try {
      const rec = await deps.createGateway(id);
      await deps.record(id, "gateway_linked", rec);
      linked.push(id);
    } catch (e) {
      if (deps.isGatewayRefusal(e)) deps.onGatewayRefused(e);
      else deps.log?.("gateway_link_failed", { userId: id, error: String(e).slice(0, 300) });
    }
  }
  return { ready, linked, failed };
}
