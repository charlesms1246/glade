import { connection } from "next/server";
import { Suspense } from "react";
import { BellBoard } from "@/components/bell-board";
import { LiveStatus } from "@/components/live-status";
import { getBellView } from "@/lib/server/bell";

async function Board() {
  await connection();
  return <BellBoard initial={await getBellView(new Date())} />;
}

export default function BellPage() {
  return (
    <div className="mx-auto max-w-5xl px-6 py-16">
      <Suspense fallback={<div className="h-9" />}>
        <LiveStatus />
      </Suspense>
      <h1 className="mt-6 font-display text-4xl tracking-tight text-forest-deep">Bell</h1>
      <p className="mt-3 max-w-2xl text-ink-soft">
        While NYSE is closed, each stock&apos;s perpetual keeps trading. Bell records the perp&apos;s premium to the stock
        at the close, then reads the perp now to estimate where the stock will open.
      </p>
      <div className="mt-10">
        <Suspense fallback={<p className="text-ink-soft">Reading live prices…</p>}>
          <Board />
        </Suspense>
      </div>
    </div>
  );
}
