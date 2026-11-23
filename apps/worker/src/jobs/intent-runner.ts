import type { ExecResult } from "../executor/types";
import type { IntentRow } from "../policy/authorize";

export interface ClaimedIntent extends IntentRow {
  hedgeId: string | null;
  qtyUnit: "base" | "quote";
  reason: string;
}

export interface IntentRunnerDeps {
  /** Atomically move up to `limit` pending intents to executing and return them. */
  claim: (limit: number) => Promise<ClaimedIntent[]>;
  execute: (intent: ClaimedIntent) => Promise<ExecResult>;
  onResult: (intent: ClaimedIntent, result: ExecResult) => Promise<void>;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

/** Executes claimed intents one at a time so a user's legs run in order. Errors become failed results. */
export async function runPendingIntents(deps: IntentRunnerDeps, limit = 10): Promise<ExecResult[]> {
  const results: ExecResult[] = [];
  for (const intent of await deps.claim(limit)) {
    let result: ExecResult;
    try {
      result = await deps.execute(intent);
    } catch (e) {
      deps.log?.("intent_error", { intentId: intent.id, error: String(e).slice(0, 300) });
      result = { outcome: "failed", reason: String(e).slice(0, 300) };
    }
    await deps.onResult(intent, result);
    results.push(result);
  }
  return results;
}

/** One plain-English line for the activity log. */
export function explainResult(i: ClaimedIntent, r: ExecResult): string {
  const what = `${i.kind.replace("_", " ")} ${i.side} ${i.qty}${i.qtyUnit === "quote" ? " USD" : ""}${i.reduceOnly ? " (reduce-only)" : ""}`;
  switch (r.outcome) {
    case "complete":
      return `Filled: ${what}${r.row.avgPrice ? ` at ${r.row.avgPrice}` : ""}${r.row.fee ? `, fee ${r.row.fee}` : ""}. ${i.reason}`;
    case "rejected":
      return `Not placed: ${what}. Blocked by policy: ${r.reasons.join("; ")}.`;
    case "failed":
      return `Failed: ${what}. ${r.reason}.`;
    case "unknown":
      return `Submitted ${what}; the result is not confirmed yet and will be reconciled.`;
  }
}
