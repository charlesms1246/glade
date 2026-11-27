import Link from "next/link";
import { Suspense } from "react";
import { LiveStatus } from "@/components/live-status";

const modes = [
  {
    name: "Shield",
    line: "One tap to hedge a share of your holdings.",
    body: "Glade sizes a short perpetual against what you hold, shows the cost, funding and liquidation price, and asks for your passkey before anything is placed.",
  },
  {
    name: "Floor",
    line: "Choose a target, and Glade keeps the hedge on it.",
    body: "You sign a mandate once. Glade raises the hedge as your cushion shrinks and lowers it as you recover. It can only open or trim a short; it never trades your stock or moves your funds.",
  },
  {
    name: "Bell",
    line: "See the gap before the market opens.",
    body: "When NYSE is closed, the perp keeps trading. Bell turns it into an estimate of the opening price, with an error band measured on past closures, and can shield you until the bell.",
  },
];

export default function Home() {
  return (
    <div className="mx-auto max-w-5xl px-6">
      <section className="py-20 sm:py-28">
        <Suspense fallback={<div className="h-9" />}>
          <LiveStatus />
        </Suspense>
        <h1 className="mt-8 max-w-3xl font-display text-5xl leading-[1.05] tracking-tight text-forest-deep sm:text-6xl">
          Set the most you are willing to lose, even when Wall Street sleeps.
        </h1>
        <p className="mt-6 max-w-2xl text-lg leading-relaxed text-ink-soft">
          Glade protects tokenized US stocks with perpetual futures on True Markets. Hedge in one tap, set a loss target
          that Glade works to keep (a target, not a guarantee), and see the opening gap while the market is closed.
        </p>
        <div className="mt-10 flex flex-wrap gap-3">
          <Link href="/login" className="rounded-full bg-forest px-6 py-3 text-sm font-medium text-paper hover:bg-forest-deep">
            Try it on paper
          </Link>
          <Link href="/bell" className="rounded-full border border-forest/30 px-6 py-3 text-sm font-medium text-forest hover:bg-sand">
            See the live Bell estimate
          </Link>
          <Link href="/replay" className="rounded-full border border-forest/30 px-6 py-3 text-sm font-medium text-forest hover:bg-sand">
            Replay the Floor on real prices
          </Link>
        </div>
      </section>

      <section className="grid gap-6 pb-24 sm:grid-cols-3">
        {modes.map((m) => (
          <article key={m.name} className="rounded-2xl bg-sand p-7">
            <h2 className="font-display text-3xl text-forest-deep">{m.name}</h2>
            <p className="mt-3 font-medium">{m.line}</p>
            <p className="mt-3 text-sm leading-relaxed text-ink-soft">{m.body}</p>
          </article>
        ))}
      </section>
    </div>
  );
}
