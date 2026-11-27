import { dec } from "@glade/shared";
import { z } from "zod";

const legSchema = z.object({
  assetId: z.string(),
  side: z.enum(["buy", "sell"]),
  qty: z.string(),
  reduceOnly: z.boolean(),
  notionalUsd: z.string(),
  beta: z.string(),
});

export interface LegRef {
  assetId: string;
  qty: string;
}

export interface DueHedge {
  hedgeId: string;
  userId: string;
  /** Inputs of one of the hedge's open intents: carries the approved plan and passkey assertion. */
  openInputs: unknown;
  planHash: string;
  /** Open legs that filled. Only these are closed. */
  doneOpens: LegRef[];
  /** Close legs that already filled. These are not closed again. */
  doneCloses: LegRef[];
  /** Failed or rejected close attempts so far, per leg. */
  failedByLeg?: (LegRef & { n: number })[];
}

const sameLeg = (a: LegRef, b: { assetId: string; qty: string }) => a.assetId === b.assetId && dec(a.qty).eq(dec(b.qty));

export interface CloseIntentDraft {
  userId: string;
  hedgeId: string;
  kind: "close";
  assetId: string;
  side: "buy";
  qty: string;
  qtyUnit: "base";
  leverage: null;
  reduceOnly: true;
  planHash: string;
  reason: string;
  inputs: Record<string, unknown>;
}

export interface UnwindPlan {
  /** Close legs to queue now. */
  drafts: CloseIntentDraft[];
  /** Close legs that already failed `maxAttempts` times. They are not retried. */
  exhausted: CloseIntentDraft[];
  /** True only when every filled open leg has a filled close. */
  done: boolean;
  /** Set when the stored plan cannot be used to close: the hedge may still be open and must not be marked closed. */
  invalid?: string;
}

/**
 * What to do for a Bell hedge whose unwind time has come. Only the reduce-only close legs the
 * user approved in the original plan are produced, so the same passkey approval covers them.
 */
export function unwindPlan(h: DueHedge, maxAttempts = Infinity): UnwindPlan {
  const none = { drafts: [], exhausted: [], done: false };
  const inputs = (h.openInputs ?? {}) as Record<string, unknown>;
  const plan = (inputs.plan ?? {}) as { legs?: unknown[]; kind?: string };
  if (plan.kind !== "bell") return { ...none, invalid: "the stored plan is not a Shield-until-the-bell plan" };
  const legs = z.array(legSchema).safeParse(plan.legs);
  if (!legs.success) return { ...none, invalid: "the stored plan could not be read" };
  const closeLegs = legs.data.filter((l) => l.side === "buy" && l.reduceOnly);
  const orphan = h.doneOpens.find((o) => !closeLegs.some((l) => sameLeg(o, l)));
  if (orphan) return { ...none, invalid: `no approved close leg matches the open ${orphan.assetId} position` };

  const pending = closeLegs
    .filter((l) => h.doneOpens.some((o) => sameLeg(o, l)) && !h.doneCloses.some((c) => sameLeg(c, l)))
    .map((l) => ({
      leg: l,
      draft: {
        userId: h.userId,
        hedgeId: h.hedgeId,
        kind: "close" as const,
        assetId: l.assetId,
        side: "buy" as const,
        qty: l.qty,
        qtyUnit: "base" as const,
        leverage: null,
        reduceOnly: true as const,
        planHash: h.planHash,
        reason: "Shield until the bell: the market has opened, so the hedge is closed as approved.",
        inputs: { ...inputs, notionalUsd: l.notionalUsd },
      },
    }));
  const failures = (l: { assetId: string; qty: string }) => (h.failedByLeg ?? []).filter((f) => sameLeg(f, l)).reduce((a, f) => a + f.n, 0);
  return {
    drafts: pending.filter((x) => failures(x.leg) < maxAttempts).map((x) => x.draft),
    exhausted: pending.filter((x) => failures(x.leg) >= maxAttempts).map((x) => x.draft),
    done: pending.length === 0,
  };
}

/** Close intents for a Bell hedge whose unwind time has come (no retry cap). */
export function unwindDrafts(h: DueHedge): CloseIntentDraft[] {
  return unwindPlan(h).drafts;
}

export interface BellUnwindDeps {
  due: () => Promise<(DueHedge & { failedByLeg: (LegRef & { n: number })[] })[]>;
  insertCloses: (drafts: CloseIntentDraft[]) => Promise<void>;
  markClosed: (hedgeId: string) => Promise<void>;
  /** True when a stuck alert was already recorded for this hedge. */
  alreadyAlerted: (hedgeId: string) => Promise<boolean>;
  alert: (h: DueHedge, explanation: string, detail: Record<string, unknown>) => Promise<void>;
  paused: () => boolean;
  maxAttempts: number;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

/** Closes due Bell hedges leg by leg; a hedge is marked closed only when every filled leg has a filled close. */
export async function runBellUnwind(d: BellUnwindDeps): Promise<void> {
  if (d.paused()) return;
  for (const h of await d.due()) {
    const p = unwindPlan(h, d.maxAttempts);
    if (p.done) {
      await d.markClosed(h.hedgeId);
      continue;
    }
    const stuck = p.invalid
      ? `Shield until the bell could not be closed automatically: ${p.invalid}. The hedge may still be open; unshield it manually.`
      : p.exhausted.length
        ? `Shield until the bell could not close ${p.exhausted.length} leg(s) after ${d.maxAttempts} attempts. The hedge is still open; unshield it manually.`
        : null;
    if (stuck && !(await d.alreadyAlerted(h.hedgeId))) {
      await d.alert(h, stuck, { invalid: p.invalid ?? null, exhaustedLegs: p.exhausted.map((x) => x.assetId) });
    }
    if (p.drafts.length) {
      await d.insertCloses(p.drafts);
      d.log?.("bell_unwind_queued", { hedgeId: h.hedgeId, legs: p.drafts.length });
    }
  }
}
