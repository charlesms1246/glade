import { stampPayload } from "@glade/stamp";
import { TmApiError, type OrderDetail } from "@glade/tm-client";
import { prodGuard } from "./guard";
import type { ExecIntent, ExecResult, ExecutorDeps, ExecVenue, OrderRow } from "./types";

const FINAL = new Set(["complete", "canceled", "failed", "failed_funding"]);
const MAX_ATTEMPTS = 2; // first try + one recreate after quote_stale or a never-executed order
/**
 * True Markets quotes expire after about 2 minutes, after which execute fails with quote_stale.
 * An order still "initialized" past this age can therefore never fill (5 s of slack on top).
 */
export const NEVER_EXECUTED_AFTER_MS = 125_000;

type PollResult = ExecResult | { outcome: "never_executed"; row: OrderRow };

/**
 * create → stamp → execute → poll, for one intent. Safe to re-run: an attempt that already
 * reached True Markets is only ever polled, never re-created or re-executed.
 */
export function createExecutor(venue: ExecVenue, deps: ExecutorDeps) {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = deps.log ?? (() => {});
  const pollEvery = deps.config.pollIntervalMs ?? 2000;
  const pollTimeout = deps.config.pollTimeoutMs ?? 120_000;

  async function gate(intent: ExecIntent): Promise<string[]> {
    const hard = prodGuard(intent, deps.config, venue);
    if (hard.length) return hard;
    const policy = await deps.authorize(intent);
    return policy.ok ? [] : policy.reasons;
  }

  /** Retire an order that was never executed: best-effort cancel, then mark the attempt failed. */
  async function abandon(intent: ExecIntent, row: OrderRow): Promise<PollResult> {
    const user = venue.forUser(intent.venueUserId);
    try {
      await user.cancelOrder?.(row.tmOrderId!);
    } catch (e) {
      log("cancel_error", { intentId: intent.id, tmOrderId: row.tmOrderId, error: String(e) });
    }
    await deps.repo.updateOrder(intent.id, row.attempt, { status: "failed", raw: { reason: "never executed" } });
    log("never_executed", { intentId: intent.id, attempt: row.attempt, tmOrderId: row.tmOrderId });
    return { outcome: "never_executed", row: { ...row, status: "failed" } };
  }

  async function poll(intent: ExecIntent, row: OrderRow): Promise<PollResult> {
    const user = venue.forUser(intent.venueUserId);
    const tmOrderId = row.tmOrderId!;
    const deadline = now() + pollTimeout;
    // Age of a still-"initialized" order: from the row if known, else from when this poll first saw it.
    let initializedSince: number | null = row.createdAtMs ?? null;
    for (;;) {
      let o: OrderDetail;
      try {
        o = await user.getOrder(tmOrderId);
      } catch (e) {
        log("poll_error", { intentId: intent.id, tmOrderId, error: String(e) });
        o = {};
      }
      if (o.status === "complete" || o.status === "canceled" || o.status === "failed") {
        const patch: Partial<OrderRow> = {
          status: o.status,
          executedQty: o.executed_qty ?? null,
          avgPrice: o.executed_vwap ?? null,
          fee: o.fee ?? null,
          explorerUrl: o.explorer_url ?? null,
          raw: o,
        };
        await deps.repo.updateOrder(intent.id, row.attempt, patch);
        const done = { ...row, ...patch };
        if (o.status === "complete") {
          await deps.repo.setIntentStatus(intent.id, "done");
          return { outcome: "complete", tmOrderId, row: done };
        }
        await deps.repo.setIntentStatus(intent.id, "failed");
        return { outcome: "failed", reason: o.failure_reason ?? o.status, row: done };
      }
      if (o.status === "initialized") {
        initializedSince ??= now();
        if (now() - initializedSince >= NEVER_EXECUTED_AFTER_MS) return abandon(intent, row);
        // Keep polling past the deadline: an initialized order resolves once its quote expires.
      } else if (now() >= deadline) {
        await deps.repo.updateOrder(intent.id, row.attempt, { status: "unknown" });
        log("poll_timeout", { intentId: intent.id, tmOrderId });
        return { outcome: "unknown", tmOrderId };
      }
      await sleep(pollEvery);
    }
  }

  const neverExecuted = async (intent: ExecIntent): Promise<ExecResult> => {
    await deps.repo.setIntentStatus(intent.id, "failed");
    return { outcome: "failed", reason: "order was never executed" };
  };

  async function execute(intent: ExecIntent): Promise<ExecResult> {
    const existing = (await deps.repo.listOrders(intent.id)).sort((a, b) => a.attempt - b.attempt);
    const last = existing.at(-1);
    let budget = MAX_ATTEMPTS;

    // Resume: anything that may have reached True Markets is polled, not repeated.
    if (last?.tmOrderId && !FINAL.has(last.status)) {
      if (last.status === "created") {
        // Created but never signed or executed, so it cannot fill. Start a fresh attempt.
        log("resume_created", { intentId: intent.id, attempt: last.attempt });
      } else {
        const r = await poll(intent, last);
        if (r.outcome !== "never_executed") return r;
        // Recreate at most once in total after a never-executed order.
        if (last.attempt >= MAX_ATTEMPTS) return neverExecuted(intent);
        budget = 1;
      }
    }
    if (last?.status === "complete") return { outcome: "complete", tmOrderId: last.tmOrderId!, row: last };
    if (last?.status === "failed" && (last.raw as { reason?: string } | undefined)?.reason === "never executed") {
      // Crashed after retiring a never-executed order: the one recreate is still owed, nothing more.
      if (last.attempt >= MAX_ATTEMPTS) return neverExecuted(intent);
      budget = 1;
    }

    let attempt = (last?.attempt ?? 0) + 1;
    const firstAttempt = attempt;
    for (; attempt < firstAttempt + budget; attempt++) {
      const blocked = await gate(intent);
      if (blocked.length) {
        await deps.repo.setIntentStatus(intent.id, "rejected");
        log("rejected", { intentId: intent.id, reasons: blocked });
        return { outcome: "rejected", reasons: blocked };
      }

      const row: OrderRow = { intentId: intent.id, attempt, tmOrderId: null, status: "created" };
      await deps.repo.insertOrder(row);
      await deps.repo.setIntentStatus(intent.id, "executing");
      const user = venue.forUser(intent.venueUserId);

      const created = await user.createOrder({
        asset_id: intent.assetId,
        side: intent.side,
        type: "market",
        qty: intent.qty,
        qty_unit: intent.qtyUnit,
        venue: intent.venue,
        ...(intent.leverage !== null ? { leverage: intent.leverage } : {}),
        ...(intent.reduceOnly ? { reduce_only: true } : {}),
      });

      if (!created.order_id) {
        // 201 with an empty order_id: no order exists. The reason is in quote.issues.
        const issues = created.quote?.issues ?? [];
        await deps.repo.updateOrder(intent.id, attempt, { status: "failed_funding", raw: created });
        await deps.repo.setIntentStatus(intent.id, "failed");
        return { outcome: "failed", reason: `no order created: ${issues.join(", ") || "unknown"}` };
      }
      row.tmOrderId = created.order_id;
      await deps.repo.updateOrder(intent.id, attempt, { tmOrderId: created.order_id, raw: created });

      const payloads = created.payloads ?? [];
      if (payloads.length === 0) {
        // Already submitted by the venue (CeFi): poll only.
        await deps.repo.updateOrder(intent.id, attempt, { status: "submitted" });
        const r = await poll(intent, { ...row, status: "submitted" });
        if (r.outcome === "never_executed") continue;
        return r;
      }

      // Re-check policy immediately before stamping.
      const late = await gate(intent);
      if (late.length) {
        await deps.repo.updateOrder(intent.id, attempt, { status: "canceled" });
        await deps.repo.setIntentStatus(intent.id, "rejected");
        return { outcome: "rejected", reasons: late };
      }
      const signer = await deps.signerFor(intent.userId);
      // Only payloads returned for this attempt's order, in the order received.
      const signatures = payloads.map((p) => stampPayload(p.payload, signer));
      await deps.repo.updateOrder(intent.id, attempt, { status: "signed" });

      try {
        await user.executeOrder(created.order_id, signatures);
      } catch (e) {
        if (e instanceof TmApiError && e.isAlreadySubmitted) {
          await deps.repo.updateOrder(intent.id, attempt, { status: "submitted" });
          const r = await poll(intent, { ...row, status: "submitted" });
          if (r.outcome === "never_executed") continue;
          return r;
        }
        if (e instanceof TmApiError && e.isQuoteStale) {
          await deps.repo.updateOrder(intent.id, attempt, { status: "failed", raw: { error: e.body } });
          log("quote_stale", { intentId: intent.id, attempt, requestId: e.requestId });
          continue; // recreate once
        }
        // Unknown outcome: the order may or may not be live. Poll rather than retry.
        await deps.repo.updateOrder(intent.id, attempt, { status: "submitted" });
        log("execute_error", { intentId: intent.id, attempt, error: String(e) });
        const r = await poll(intent, { ...row, status: "submitted" });
        if (r.outcome === "never_executed") continue;
        return r;
      }
      await deps.repo.updateOrder(intent.id, attempt, { status: "submitted" });
      const r = await poll(intent, { ...row, status: "submitted" });
      if (r.outcome === "never_executed") continue;
      return r;
    }
    const lastRow = (await deps.repo.listOrders(intent.id)).sort((a, b) => a.attempt - b.attempt).at(-1);
    if ((lastRow?.raw as { reason?: string } | undefined)?.reason === "never executed") return neverExecuted(intent);
    await deps.repo.setIntentStatus(intent.id, "failed");
    return { outcome: "failed", reason: "quote stale after retry" };
  }

  return { execute };
}

export type Executor = ReturnType<typeof createExecutor>;
