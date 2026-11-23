"use client";

import Link from "next/link";
import { useState } from "react";
import { approve, type Offer } from "@/lib/client/approve";
import { api, errText } from "@/lib/client/http";
import type { ShieldPlan } from "@/lib/server/shield";
import { ShieldPlanView } from "./shield-plan-view";

const at = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit", timeZoneName: "short" });

export function BellShield() {
  const [ratio, setRatio] = useState(100);
  const [offer, setOffer] = useState<Offer<ShieldPlan> | null>(null);
  const [done, setDone] = useState(false);
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

  if (done && offer?.plan.unwindAt) {
    return (
      <p className="rounded-2xl bg-sand p-6" aria-live="polite">
        Shield until the bell is queued. It unwinds automatically at {at(offer.plan.unwindAt)}.{" "}
        <Link href="/activity" className="text-forest underline">
          Follow it in Activity
        </Link>
      </p>
    );
  }

  return (
    <section className="rounded-2xl border border-sand-deep bg-white/70 p-7">
      <h2 className="font-display text-2xl text-forest-deep">Shield until the bell</h2>
      <p className="mt-2 text-sm text-ink-soft">
        Hedge your holdings while the market is closed. One passkey approval covers both the hedge now and its reduce-only
        unwind 5 minutes after the open.
      </p>
      <div className="mt-5 flex items-center gap-4">
        <input
          type="range"
          min={5}
          max={100}
          step={5}
          value={ratio}
          aria-label="Hedge ratio"
          onChange={(e) => {
            setRatio(Number(e.target.value));
            setOffer(null);
          }}
          className="w-full accent-[var(--forest)]"
        />
        <span className="num w-14 text-right text-xl text-forest">{ratio}%</span>
      </div>
      <button
        onClick={() => void step(async () => setOffer(await api<Offer<ShieldPlan>>("/api/shield/plan", { ratio: (ratio / 100).toFixed(2), kind: "bell" })))}
        disabled={busy}
        className="mt-5 rounded-full bg-forest px-6 py-3 text-sm font-medium text-paper hover:bg-forest-deep disabled:opacity-50"
      >
        Review plan
      </button>
      {offer && (
        <div className="mt-6 rounded-xl bg-sand p-6">
          {offer.plan.unwindAt && <p className="mb-4 text-sm">Unwinds automatically at {at(offer.plan.unwindAt)}. Fees shown include the unwind.</p>}
          <ShieldPlanView plan={offer.plan} />
          <button
            onClick={() =>
              void step(async () => {
                await approve(offer, "/api/shield/confirm");
                setDone(true);
              })
            }
            disabled={busy || !offer.plan.ok}
            className="mt-6 rounded-full bg-forest px-6 py-3 text-sm font-medium text-paper hover:bg-forest-deep disabled:opacity-50"
          >
            Approve with passkey
          </button>
        </div>
      )}
      {error && <p role="alert" className="mt-4 text-sm text-rose">{error}</p>}
    </section>
  );
}
