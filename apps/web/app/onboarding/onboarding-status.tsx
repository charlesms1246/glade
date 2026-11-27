"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/client/http";

type Status = { ready: false } | { ready: true; cashUsd: string; tmLinked: boolean };

const usd = (v: string) => `$${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function OnboardingStatus() {
  const [status, setStatus] = useState<Status>({ ready: false });
  const [error, setError] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);
  const router = useRouter();

  // Paper trading needs only the paper account, so polling stops as soon as it exists.
  const ready = status.ready;
  useEffect(() => {
    if (ready) return;
    const slowTimer = setTimeout(() => setSlow(true), 60_000);
    let alive = true;
    const poll = async () => {
      try {
        const s = await api<Status>("/api/onboarding/status");
        if (alive) {
          setStatus(s);
          setError(null);
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void poll();
    const t = setInterval(poll, 3000);
    return () => {
      alive = false;
      clearInterval(t);
      clearTimeout(slowTimer);
    };
  }, [ready]);

  useEffect(() => {
    if (!ready) return;
    const t = setTimeout(() => router.push("/buy"), 2000);
    return () => clearTimeout(t);
  }, [ready, router]);

  if (!status.ready) {
    return (
      <div className="rounded-2xl bg-sand p-7" aria-live="polite">
        <p className="font-medium">Setting up your paper account…</p>
        <p className="mt-2 text-sm text-ink-soft">
          Glade is creating your paper account and funding it with paper USDC. This usually takes a few seconds.
        </p>
        {slow && <p className="mt-3 text-sm text-ink-soft">This is taking longer than usual. You can leave this page open or check back in a minute.</p>}
        {error && <p className="mt-3 text-sm text-rose">{error}</p>}
      </div>
    );
  }

  return (
    <div className="rounded-2xl bg-sand p-7" aria-live="polite">
      <p className="text-xs uppercase tracking-wider text-ink-soft">Paper account ready</p>
      <p className="num mt-2 font-display text-4xl text-forest-deep">{usd(status.cashUsd)} paper USDC</p>
      <p className="mt-3 text-sm text-ink-soft">Simulated funds for practice. Prices are live; no real money moves. Taking you to Buy…</p>
      <p className="mt-2 text-xs text-ink-soft">
        True Markets account: {status.tmLinked ? "linked" : "pending (optional; paper trading works without it)"}
      </p>
      <div className="mt-6 flex flex-wrap gap-3">
        <Link href="/buy" className="rounded-full bg-forest px-6 py-3 text-sm font-medium text-paper hover:bg-forest-deep">
          Buy a stock to protect
        </Link>
        <Link href="/home" className="rounded-full border border-forest/30 px-6 py-3 text-sm font-medium text-forest hover:bg-sand-deep">
          Go to home
        </Link>
      </div>
    </div>
  );
}
