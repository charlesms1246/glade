"use client";

import { qty, usd } from "@/lib/client/format";
import { usePoll } from "@/lib/client/use-poll";
import type { ActivityItem } from "@/lib/server/activity";

const STATUS: Record<string, { label: string; className: string }> = {
  pending: { label: "Queued", className: "bg-sand text-ink-soft" },
  executing: { label: "Placing", className: "bg-sand text-forest" },
  created: { label: "Placing", className: "bg-sand text-forest" },
  signed: { label: "Placing", className: "bg-sand text-forest" },
  submitted: { label: "Submitted", className: "bg-sand text-forest" },
  complete: { label: "Filled", className: "bg-forest text-paper" },
  done: { label: "Done", className: "bg-forest text-paper" },
  canceled: { label: "Canceled", className: "bg-sand-deep text-ink-soft" },
  rejected: { label: "Not placed", className: "bg-rose/15 text-rose" },
  failed: { label: "Failed", className: "bg-rose/15 text-rose" },
  failed_funding: { label: "Not enough funds", className: "bg-rose/15 text-rose" },
  unknown: { label: "Checking", className: "bg-sand text-ink-soft" },
};

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export function ActivityFeed() {
  const { data, error } = usePoll<{ items: ActivityItem[] }>("/api/activity", 5000);
  if (!data) return error ? <p className="text-rose">{error}</p> : <div className="h-40 rounded-2xl bg-sand" />;
  if (data.items.length === 0) return <p className="rounded-2xl bg-sand p-6 text-ink-soft">Nothing yet. Orders and engine decisions appear here.</p>;

  return (
    <ol className="space-y-3">
      {data.items.map((it) => {
        const s = it.status ? STATUS[it.status] ?? { label: it.status, className: "bg-sand text-ink-soft" } : null;
        return (
          <li key={it.id} className="rounded-2xl border border-sand-deep bg-white/80 p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="font-medium first-letter:uppercase">{it.title}</p>
              <div className="flex items-center gap-3">
                {s && <span className={`rounded-full px-2.5 py-0.5 text-xs ${s.className}`}>{s.label}</span>}
                <time className="text-xs text-ink-soft" dateTime={it.at}>
                  {when(it.at)}
                </time>
              </div>
            </div>
            <p className="mt-2 text-sm leading-relaxed text-ink-soft">{it.explanation}</p>
            {it.fill?.qty && (
              <p className="num mt-2 text-xs text-ink-soft">
                Filled {qty(it.fill.qty)}
                {it.fill.price ? ` @ ${usd(it.fill.price)}` : ""}
                {it.fill.fee ? ` · fee ${usd(it.fill.fee, 4)}` : ""}
                {it.fill.explorerUrl && (
                  <>
                    {" · "}
                    <a href={it.fill.explorerUrl} target="_blank" rel="noreferrer" className="text-forest underline">
                      receipt
                    </a>
                  </>
                )}
              </p>
            )}
          </li>
        );
      })}
    </ol>
  );
}
