"use client";

import Link from "next/link";
import { useState } from "react";
import { ShieldPlanView } from "@/components/shield-plan-view";
import { approve, type Offer } from "@/lib/client/approve";
import { qty, signedUsd, usd } from "@/lib/client/format";
import { api, errText } from "@/lib/client/http";
import { usePoll } from "@/lib/client/use-poll";
import type { PortfolioView } from "@/lib/server/portfolio";
import type { ShieldPlan, UnshieldPlan } from "@/lib/server/shield";

export function ShieldFlow() {
  const { data: pf, refresh } = usePoll<PortfolioView>("/api/portfolio");
  const [ratio, setRatio] = useState(75);
  const [offer, setOffer] = useState<Offer<ShieldPlan> | null>(null);
  const [unshield, setUnshield] = useState<Offer<UnshieldPlan> | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function step(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  const review = () =>
    step(async () => {
      setNotice(null);
      setOffer(await api<Offer<ShieldPlan>>("/api/shield/plan", { ratio: (ratio / 100).toFixed(2), kind: "shield" }));
    });
  const confirm = () =>
    step(async () => {
      await approve(offer!, "/api/shield/confirm");
      setOffer(null);
      setNotice("Shield queued. The executor opens each leg within a few seconds.");
      void refresh();
    });
  const reviewUnshield = () => step(async () => setUnshield(await api<Offer<UnshieldPlan>>("/api/shield/unshield/plan", {})));
  const confirmUnshield = () =>
    step(async () => {
      await approve(unshield!, "/api/shield/unshield/confirm");
      setUnshield(null);
      setNotice("Unshield queued. Each hedge is bought back with reduce-only orders.");
      void refresh();
    });

  const hasStocks = pf && pf.holdings.length > 0;

  return (
    <div className="space-y-6">
      {pf && pf.positions.length > 0 && (
        <section className="rounded-2xl border border-sand-deep bg-white/70 p-7">
          <h2 className="font-display text-2xl text-forest-deep">Open hedges</h2>
          <ul className="num mt-4 divide-y divide-sand-deep text-sm">
            {pf.positions.map((p) => (
              <li key={p.assetId} className="flex flex-wrap justify-between gap-2 py-2.5">
                <span>
                  Short {qty(p.size)} {p.symbol} <span className="text-ink-soft">({p.mode})</span>
                </span>
                <span className="text-ink-soft">
                  {usd(p.notionalUsd)} · liq. {p.liquidationPrice ? usd(p.liquidationPrice) : "—"} · P&amp;L {p.unrealizedPnlUsd ? signedUsd(p.unrealizedPnlUsd) : "—"}
                </span>
              </li>
            ))}
          </ul>
          {!unshield ? (
            <button onClick={() => void reviewUnshield()} disabled={busy} className="mt-5 rounded-full border border-forest/30 px-6 py-3 text-sm font-medium text-forest hover:bg-sand disabled:opacity-50">
              Unshield…
            </button>
          ) : (
            <div className="mt-5 rounded-xl bg-sand p-5 text-sm">
              <p>
                Close {unshield.plan.legs.length} Shield/Bell hedge leg{unshield.plan.legs.length > 1 ? "s" : ""} with reduce-only buys. Estimated
                fees {usd(unshield.plan.feesUsd, 4)}. Your stocks stay as they are, and hedges placed by your Floor mandate stay with the
                Floor.
              </p>
              <div className="mt-4 flex gap-3">
                <button onClick={() => void confirmUnshield()} disabled={busy} className="rounded-full bg-forest px-5 py-2.5 font-medium text-paper hover:bg-forest-deep disabled:opacity-50">
                  Approve with passkey
                </button>
                <button onClick={() => setUnshield(null)} className="rounded-full px-5 py-2.5 text-ink-soft hover:text-forest">
                  Cancel
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {pf && !hasStocks ? (
        <div className="rounded-2xl bg-sand p-7">
          <p>You hold no stocks yet, so there is nothing to shield.</p>
          <Link href="/buy" className="mt-4 inline-block rounded-full bg-forest px-6 py-3 text-sm font-medium text-paper hover:bg-forest-deep">
            Buy a stock
          </Link>
        </div>
      ) : (
        <section className="rounded-2xl border border-sand-deep bg-white/70 p-7">
          <div className="flex items-baseline justify-between">
            <label htmlFor="ratio" className="font-display text-2xl text-forest-deep">
              Hedge ratio
            </label>
            <span className="num text-3xl text-forest">{ratio}%</span>
          </div>
          <input
            id="ratio"
            type="range"
            min={5}
            max={100}
            step={5}
            value={ratio}
            onChange={(e) => {
              setRatio(Number(e.target.value));
              setOffer(null);
            }}
            className="mt-4 w-full accent-[var(--forest)]"
          />
          <p className="mt-2 text-sm text-ink-soft">
            Share of your stock value ({pf ? usd(pf.stockValueUsd) : "…"}) offset by a short perp. 100% means a fall in the stock is
            matched by a gain on the hedge, before costs.
          </p>
          <button onClick={() => void review()} disabled={busy || !pf} className="mt-6 rounded-full bg-forest px-6 py-3 text-sm font-medium text-paper hover:bg-forest-deep disabled:opacity-50">
            Review plan
          </button>
        </section>
      )}

      {offer && (
        <section className="rounded-2xl bg-sand p-7">
          <h2 className="font-display text-2xl text-forest-deep">Shield {Math.round(Number(offer.plan.ratio) * 100)}%</h2>
          <div className="mt-5">
            <ShieldPlanView plan={offer.plan} />
          </div>
          <button onClick={() => void confirm()} disabled={busy || !offer.plan.ok} className="mt-6 rounded-full bg-forest px-6 py-3 text-sm font-medium text-paper hover:bg-forest-deep disabled:opacity-50">
            Approve with passkey
          </button>
          <p className="mt-3 text-xs text-ink-soft">Valid for 5 minutes. Paper orders fill at the live mark.</p>
        </section>
      )}
      {notice && (
        <p className="rounded-xl bg-sand p-4 text-sm" aria-live="polite">
          {notice} <Link href="/activity" className="text-forest underline">Activity</Link>
        </p>
      )}
      {error && <p role="alert" className="text-sm text-rose">{error}</p>}
    </div>
  );
}
