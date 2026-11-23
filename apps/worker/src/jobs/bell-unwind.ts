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
}

const sameLeg = (a: LegRef, b: { assetId: string; qty: string }) => a.assetId === b.assetId && Number(a.qty) === Number(b.qty);

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

/**
 * Close intents for a Bell hedge whose unwind time has come. Only the reduce-only close legs the
 * user approved in the original plan are produced, so the same passkey approval covers them.
 */
export function unwindDrafts(h: DueHedge): CloseIntentDraft[] {
  const inputs = (h.openInputs ?? {}) as Record<string, unknown>;
  const plan = (inputs.plan ?? {}) as { legs?: unknown[]; kind?: string };
  if (plan.kind !== "bell") return [];
  const legs = z.array(legSchema).safeParse(plan.legs);
  if (!legs.success) return [];
  return legs.data
    .filter((l) => l.side === "buy" && l.reduceOnly)
    .filter((l) => h.doneOpens.some((o) => sameLeg(o, l)) && !h.doneCloses.some((c) => sameLeg(c, l)))
    .map((l) => ({
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
    }));
}
