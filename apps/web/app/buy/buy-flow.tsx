"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { FillStatus } from "@/components/fill-status";
import { approve, type Offer } from "@/lib/client/approve";
import { usd, qty } from "@/lib/client/format";
import { api, errText } from "@/lib/client/http";
import type { BuyPlan } from "@/lib/server/buy";
import type { StockListing } from "@/lib/server/market";

export function BuyFlow() {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<StockListing[]>([]);
  const [pick, setPick] = useState<StockListing | null>(null);
  const [amount, setAmount] = useState("25");
  const [offer, setOffer] = useState<Offer<BuyPlan> | null>(null);
  const [intentId, setIntentId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!q.trim() || pick?.symbol === q) return;
    const t = setTimeout(async () => {
      try {
        setResults((await api<{ results: StockListing[] }>(`/api/stocks?q=${encodeURIComponent(q)}`)).results);
      } catch (e) {
        setError(errText(e));
      }
    }, 250);
    return () => clearTimeout(t);
  }, [q, pick]);

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

  const preview = () => step(async () => setOffer(await api<Offer<BuyPlan>>("/api/buy/plan", { symbol: pick!.symbol, usd: amount })));
  const confirm = () =>
    step(async () => {
      const r = await approve<BuyPlan, { intentId: string }>(offer!, "/api/buy/confirm");
      setIntentId(r.intentId);
    });

  if (intentId && offer) {
    return (
      <div className="rounded-2xl bg-sand p-7" aria-live="polite">
        <p className="font-display text-2xl text-forest-deep">Order queued</p>
        <p className="mt-2 text-ink-soft">
          Your paper buy of {usd(offer.plan.usd)} of {offer.plan.symbol} is with Glade&apos;s executor. It fills at the live price
          within a few seconds.
        </p>
        <FillStatus match={(it) => it.id === `i:${intentId}`} expected={1} />
        <div className="mt-6 flex gap-3">
          <Link href="/activity" className="rounded-full bg-forest px-6 py-3 text-sm font-medium text-paper hover:bg-forest-deep">
            Follow it in Activity
          </Link>
          <Link href="/shield" className="rounded-full border border-forest/30 px-6 py-3 text-sm font-medium text-forest hover:bg-sand-deep">
            Shield your holdings
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-sand-deep bg-white/70 p-7">
        <label htmlFor="q" className="text-sm font-medium">
          Stock
        </label>
        <input
          id="q"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPick(null);
            setOffer(null);
          }}
          placeholder="Search by ticker or name, e.g. NVDA"
          autoComplete="off"
          className="mt-2 w-full rounded-xl border border-sand-deep bg-paper px-4 py-3 outline-none focus:border-forest"
        />
        {!pick && results.length > 0 && (
          <ul className="mt-2 max-h-72 overflow-auto rounded-xl border border-sand-deep bg-paper">
            {results.map((r) => (
              <li key={r.assetId}>
                <button
                  className="flex w-full items-baseline justify-between px-4 py-2.5 text-left hover:bg-sand"
                  onClick={() => {
                    setPick(r);
                    setQ(r.symbol);
                    setResults([]);
                  }}
                >
                  <span className="font-medium">{r.symbol}</span>
                  <span className="ml-4 truncate text-sm text-ink-soft">{r.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <label htmlFor="amt" className="mt-6 block text-sm font-medium">
          Amount (USD)
        </label>
        <input
          id="amt"
          inputMode="decimal"
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value);
            setOffer(null);
          }}
          className="num mt-2 w-full rounded-xl border border-sand-deep bg-paper px-4 py-3 outline-none focus:border-forest"
        />
        <button onClick={() => void preview()} disabled={busy || !pick || !amount} className="mt-6 rounded-full bg-forest px-6 py-3 text-sm font-medium text-paper hover:bg-forest-deep disabled:opacity-50">
          Preview at live price
        </button>
      </div>

      {offer && (
        <div className="rounded-2xl bg-sand p-7">
          <h2 className="font-display text-2xl text-forest-deep">
            Buy {offer.plan.symbol} <span className="text-base text-ink-soft">{offer.plan.name}</span>
          </h2>
          <dl className="num mt-5 grid grid-cols-2 gap-y-2 text-sm">
            <dt className="text-ink-soft">Live price</dt>
            <dd className="text-right">{usd(offer.plan.price)}</dd>
            <dt className="text-ink-soft">You pay</dt>
            <dd className="text-right">{usd(offer.plan.usd)}</dd>
            <dt className="text-ink-soft">Fee ({Number(offer.plan.feeBp) / 100}%)</dt>
            <dd className="text-right">{usd(offer.plan.feeUsd, 4)}</dd>
            <dt className="text-ink-soft">You receive (estimate)</dt>
            <dd className="text-right">
              {qty(offer.plan.estQty)} {offer.plan.symbol}
            </dd>
            <dt className="text-ink-soft">Paper cash after</dt>
            <dd className="text-right">{usd(Number(offer.plan.cashUsd) - Number(offer.plan.usd))}</dd>
            <dt className="text-ink-soft">Per-order limit</dt>
            <dd className="text-right">{usd(offer.plan.maxOrderUsd)}</dd>
          </dl>
          <p className="mt-4 text-xs text-ink-soft">
            Paper order: filled at the live price when the executor runs, so the final amount can differ slightly. This
            plan is valid for 5 minutes.
          </p>
          <button onClick={() => void confirm()} disabled={busy} className="mt-6 rounded-full bg-forest px-6 py-3 text-sm font-medium text-paper hover:bg-forest-deep disabled:opacity-50">
            Approve with passkey
          </button>
        </div>
      )}
      {error && <p role="alert" className="text-sm text-rose">{error}</p>}
    </div>
  );
}
