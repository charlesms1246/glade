"use client";

import { startAuthentication } from "@simplewebauthn/browser";
import Link from "next/link";
import { EquityChart } from "@/components/equity-chart";
import { useState } from "react";
import { pct, usd } from "@/lib/client/format";
import { api, errText } from "@/lib/client/http";
import { usePoll } from "@/lib/client/use-poll";
import type { FloorView, MandateOffer } from "@/lib/server/floor";

type Offer = MandateOffer & { passkey: Parameters<typeof startAuthentication>[0]["optionsJSON"] };

const list = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

function summary(t: { floorPct: string; leverageMax: string; ratchet: boolean; maxTradesDay: number; baseUsd: string }, perps: string[]) {
  const target = t.ratchet
    ? `${pct(t.floorPct)} of your highest equity since signing (starting from ${usd(t.baseUsd)})`
    : `${pct(t.floorPct)} of ${usd(t.baseUsd)}`;
  return `Glade may open or trim a short hedge on the ${list(perps)} perp${perps.length > 1 ? "s" : ""}, up to ${t.leverageMax}× leverage and at most ${t.maxTradesDay} trades a day, aiming to keep your equity above a target of ${target}. It never trades your stock, opens a long position, or moves funds.`;
}

function RiskMeter({ v }: { v: FloorView }) {
  const r = v.risk!;
  const room = 1 - Number(v.mandate!.floorPct);
  const fill = Math.max(0, Math.min(1, Number(r.cushionRatio) / room));
  const danger = r.targetAtRisk || r.liquidationAtRisk;
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <p className="text-sm text-ink-soft">Cushion above target</p>
        <p className={`num text-2xl ${danger ? "text-rose" : "text-forest"}`}>{pct(r.cushionRatio, 1)}</p>
      </div>
      <div className="mt-2 h-3 overflow-hidden rounded-full bg-sand-deep">
        <div className={`h-full ${danger ? "bg-rose" : "bg-forest"} transition-[width] duration-500`} style={{ width: `${fill * 100}%` }} />
      </div>
      <dl className="num mt-4 grid grid-cols-2 gap-y-1.5 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-ink-soft">Equity</dt>
          <dd>{usd(r.equityUsd)}</dd>
        </div>
        <div>
          <dt className="text-ink-soft">Target</dt>
          <dd>{usd(r.targetUsd)}</dd>
        </div>
        <div>
          <dt className="text-ink-soft">Hedge now</dt>
          <dd>{usd(r.hedgeNowUsd)}</dd>
        </div>
        <div>
          <dt className="text-ink-soft">Hedge the engine aims for</dt>
          <dd>{usd(r.hedgeTargetUsd)}</dd>
        </div>
      </dl>
      {r.targetAtRisk && <p className="mt-3 text-sm text-rose">Target at risk: the cushion is under 3% of equity. A sharp move could take equity below the target.</p>}
      {r.liquidationAtRisk && r.minLiqDistance && (
        <p className="mt-3 text-sm text-rose">A hedge is {pct(r.minLiqDistance, 1)} from its liquidation price (under 15%).</p>
      )}
    </div>
  );
}

export function FloorFlow() {
  const { data: v, error: loadError, refresh } = usePoll<FloorView>("/api/floor");
  const [editing, setEditing] = useState(false);
  const [floorPct, setFloorPct] = useState(85);
  const [multiplier, setMultiplier] = useState(4);
  const [ratchet, setRatchet] = useState(true);
  const [leverage, setLeverage] = useState(2);
  const [offer, setOffer] = useState<Offer | null>(null);
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
    step(async () =>
      setOffer(
        await api<Offer>("/api/floor/offer", {
          floorPct: (floorPct / 100).toFixed(2),
          multiplier: multiplier.toFixed(1),
          ratchet,
          leverageMax: leverage.toFixed(1),
        }),
      ),
    );
  const sign = () =>
    step(async () => {
      const assertion = await startAuthentication({ optionsJSON: offer!.passkey });
      await api("/api/floor/sign", { terms: offer!.terms, issuedAt: offer!.issuedAt, tag: offer!.tag, assertion });
      setOffer(null);
      setEditing(false);
      await refresh();
    });
  const setStatus = (to: "pause" | "revoke") =>
    step(async () => {
      await api(`/api/floor/${to}`, {});
      await refresh();
    });

  if (!v) return loadError ? <p className="text-rose">{loadError}</p> : <div className="h-64 rounded-2xl bg-sand" />;
  const m = v.mandate;
  const showEditor = editing || !m;
  const mark = (on: boolean) => `rounded-full px-4 py-2 text-sm ${on ? "bg-forest text-paper" : "border border-forest/30 text-forest"}`;

  return (
    <div className="space-y-6">
      {m && (
        <section className="rounded-2xl border border-sand-deep bg-white/70 p-7">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-display text-2xl text-forest-deep">Mandate v{m.version}</h2>
            <span className={`rounded-full px-3 py-1 text-xs ${m.status === "active" ? "bg-forest text-paper" : "bg-sand-deep text-ink-soft"}`}>
              {m.status === "active" ? "Active" : "Paused"}
            </span>
          </div>
          <p className="mt-3 leading-relaxed">{summary(m, m.perpSymbols)}</p>
          <p className="mt-2 text-xs text-ink-soft">
            Multiplier {m.multiplier} · signed {new Date(m.signedAt).toLocaleString()} · Glade checks every 30 seconds and waits at
            least 10 minutes between trades.
          </p>
          {v.risk && (
            <div className="mt-6">
              <RiskMeter v={v} />
            </div>
          )}
          <div className="mt-8">
            <h3 className="text-xs uppercase tracking-wider text-ink-soft">Equity and target, last 7 days</h3>
            <div className="mt-3">
              <EquityChart />
            </div>
          </div>
          <div className="mt-6 flex flex-wrap gap-3">
            {m.status === "active" && (
              <button onClick={() => void setStatus("pause")} disabled={busy} className="rounded-full border border-forest/30 px-5 py-2.5 text-sm font-medium text-forest hover:bg-sand disabled:opacity-50">
                Pause
              </button>
            )}
            <button
              onClick={() => {
                if (window.confirm("Revoke this mandate? Glade will stop managing your hedge. Open hedges stay until you unshield.")) void setStatus("revoke");
              }} disabled={busy} className="rounded-full border border-rose/40 px-5 py-2.5 text-sm font-medium text-rose hover:bg-rose/10 disabled:opacity-50">
              Revoke
            </button>
            {!editing && (
              <button onClick={() => setEditing(true)} className="rounded-full px-5 py-2.5 text-sm text-ink-soft hover:text-forest">
                {m.status === "paused" ? "Sign again to resume…" : "Change settings…"}
              </button>
            )}
          </div>
          <p className="mt-3 text-xs text-ink-soft">
            Pausing or revoking stops new Floor trades. Hedges already open stay open until you close them on{" "}
            <Link href="/shield" className="text-forest underline">
              Shield
            </Link>
            .
          </p>
        </section>
      )}

      {showEditor && (
        <section className="rounded-2xl border border-sand-deep bg-white/70 p-7">
          <h2 className="font-display text-2xl text-forest-deep">{m ? "New mandate" : "Set a Floor"}</h2>
          <p className="mt-2 text-sm text-ink-soft">
            Choose a target for your equity. Glade raises the hedge as the cushion above the target shrinks and lowers it as
            you recover. The target is what Glade aims for; fast gaps, fees and funding can still take equity below it.
          </p>

          <div className="mt-6 flex items-baseline justify-between">
            <label htmlFor="floor" className="font-medium">
              Target
            </label>
            <span className="num text-3xl text-forest">{floorPct}%</span>
          </div>
          <input id="floor" type="range" min={50} max={99} value={floorPct} onChange={(e) => (setFloorPct(Number(e.target.value)), setOffer(null))} className="mt-2 w-full accent-[var(--forest)]" />
          <p className="text-xs text-ink-soft">of your equity{ratchet ? ", rising with new highs" : ""}.</p>

          <div className="mt-6 flex items-baseline justify-between">
            <label htmlFor="mult" className="font-medium">
              Multiplier
            </label>
            <span className="num text-xl">{multiplier}</span>
          </div>
          <input id="mult" type="range" min={1} max={10} step={0.5} value={multiplier} onChange={(e) => (setMultiplier(Number(e.target.value)), setOffer(null))} className="mt-2 w-full accent-[var(--forest)]" />
          <p className="text-xs text-ink-soft">Stock exposure kept unhedged = multiplier × cushion. Higher keeps more upside and hedges later.</p>

          <div className="mt-6 grid gap-6 sm:grid-cols-2">
            <div>
              <p className="font-medium">Ratchet</p>
              <div className="mt-2 flex gap-2">
                <button aria-pressed={ratchet} onClick={() => (setRatchet(true), setOffer(null))} className={mark(ratchet)}>
                  On
                </button>
                <button aria-pressed={!ratchet} onClick={() => (setRatchet(false), setOffer(null))} className={mark(!ratchet)}>
                  Off
                </button>
              </div>
              <p className="mt-2 text-xs text-ink-soft">On: the target follows your highest equity. Off: it stays fixed.</p>
            </div>
            <div>
              <p className="font-medium">Leverage cap</p>
              <div className="mt-2 flex gap-2">
                {[1, 2, 3].map((l) => (
                  <button key={l} aria-pressed={leverage === l} onClick={() => (setLeverage(l), setOffer(null))} className={mark(leverage === l)}>
                    {l}×
                  </button>
                ))}
              </div>
              <p className="mt-2 text-xs text-ink-soft">Lower leverage posts more margin and sits further from liquidation.</p>
            </div>
          </div>

          <button onClick={() => void review()} disabled={busy} className="mt-8 rounded-full bg-forest px-6 py-3 text-sm font-medium text-paper hover:bg-forest-deep disabled:opacity-50">
            Review mandate
          </button>
        </section>
      )}

      {offer && (
        <section className="rounded-2xl bg-sand p-7">
          <h2 className="font-display text-2xl text-forest-deep">Sign mandate v{offer.terms.version}</h2>
          <p className="mt-3 leading-relaxed">{summary(offer.terms, offer.perps.map((p) => p.symbol))}</p>
          <ul className="mt-3 space-y-1 text-sm text-ink-soft">
            {offer.perps.map((p) => (
              <li key={p.assetId}>
                {p.symbol} perp hedges {list(p.hedges)}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-ink-soft">
            Costs: each Floor trade pays a 0.045% fee on its notional, and open hedges pay or receive hourly funding. Signing
            replaces any earlier mandate. You can pause or revoke at any time.
          </p>
          <button onClick={() => void sign()} disabled={busy} className="mt-6 rounded-full bg-forest px-6 py-3 text-sm font-medium text-paper hover:bg-forest-deep disabled:opacity-50">
            Sign with passkey
          </button>
        </section>
      )}
      {error && <p role="alert" className="text-sm text-rose">{error}</p>}

      <section>
        <h2 className="font-display text-2xl text-forest-deep">Floor activity</h2>
        {v.log.length === 0 ? (
          <p className="mt-4 rounded-2xl bg-sand p-6 text-ink-soft">No Floor decisions yet.</p>
        ) : (
          <ol className="mt-4 space-y-3">
            {v.log.map((l) => (
              <li key={l.id} className="rounded-2xl border border-sand-deep bg-white/80 p-5">
                <div className="flex justify-between gap-3 text-xs text-ink-soft">
                  <span className="uppercase tracking-wider">{l.action.replaceAll("_", " ")}</span>
                  <time dateTime={l.at}>{new Date(l.at).toLocaleString()}</time>
                </div>
                <p className={`mt-2 text-sm leading-relaxed ${l.action === "floor_at_risk" ? "text-rose" : ""}`}>{l.explanation}</p>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
