"use client";

import { useEffect, useState } from "react";

function until(iso: string, now: number): string {
  let s = Math.max(0, Math.floor((Date.parse(iso) - now) / 1000));
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  return d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}

const nyTime = (iso: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" }).format(new Date(iso));

const kindLabel = { overnight: "overnight", weekend: "weekend", holiday: "holiday" } as const;

export function MarketClock(props: { open: boolean; nextOpen: string; nextClose: string; kind: keyof typeof kindLabel | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  // The server snapshot goes stale once the boundary passes; prompt a refresh instead of showing a negative clock.
  const target = props.open ? props.nextClose : props.nextOpen;
  const passed = Date.parse(target) <= now;

  return (
    <div className="inline-flex items-center gap-3 rounded-full border border-sand-deep bg-white/70 px-4 py-2 text-sm">
      <span className={`h-2 w-2 rounded-full ${props.open ? "bg-moss" : "bg-rose"}`} aria-hidden />
      {passed ? (
        <span>Market status changed. Refresh for the latest.</span>
      ) : props.open ? (
        <span>
          NYSE open · closes {nyTime(props.nextClose)} ET · <span className="num">{until(props.nextClose, now)}</span>
        </span>
      ) : (
        <span>
          NYSE closed{props.kind ? ` (${kindLabel[props.kind]})` : ""} · opens {nyTime(props.nextOpen)} ET ·{" "}
          <span className="num">{until(props.nextOpen, now)}</span>
        </span>
      )}
    </div>
  );
}
