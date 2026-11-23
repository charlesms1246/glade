import { pct } from "@/lib/client/format";

const parts = [
  { key: "shielded", label: "Shielded", className: "bg-forest" },
  { key: "floored", label: "Floored", className: "bg-moss" },
  { key: "exposed", label: "Exposed", className: "bg-sand-deep" },
] as const;

/** Share of stock value hedged by Shield/Bell, by Floor, and left exposed. */
export function ExposureGauge({ exposure }: { exposure: Record<(typeof parts)[number]["key"], string> }) {
  return (
    <div>
      <div className="flex h-4 overflow-hidden rounded-full bg-sand" role="img" aria-label={parts.map((p) => `${p.label} ${pct(exposure[p.key])}`).join(", ")}>
        {parts.map((p) => (
          <div key={p.key} className={`${p.className} transition-[width] duration-500`} style={{ width: `${Number(exposure[p.key]) * 100}%` }} />
        ))}
      </div>
      <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
        {parts.map((p) => (
          <div key={p.key} className="flex items-center gap-2">
            <span className={`h-2.5 w-2.5 rounded-full ${p.className}`} />
            <dt className="text-ink-soft">{p.label}</dt>
            <dd className="num font-medium">{pct(exposure[p.key])}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
