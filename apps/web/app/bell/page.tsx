import { currentClosure } from "@glade/calendar";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { BellBoard } from "@/components/bell-board";
import { LiveStatus } from "@/components/live-status";
import { BellShield } from "@/components/bell-shield";
import { getBellView } from "@/lib/server/bell";
import { sessionUserId } from "@/lib/server/session";

async function Board() {
  await connection();
  return <BellBoard initial={await getBellView(new Date())} />;
}

async function ShieldUntilBell() {
  await connection();
  if (!currentClosure(new Date())) return null;
  if (!(await sessionUserId())) {
    return (
      <p className="rounded-2xl bg-sand p-6 text-ink-soft">
        <Link href="/login" className="text-forest underline">
          Sign in
        </Link>{" "}
        to shield your holdings until the bell.
      </p>
    );
  }
  return <BellShield />;
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
      <div className="mt-10">
        <Suspense fallback={null}>
          <ShieldUntilBell />
        </Suspense>
      </div>
    </div>
  );
}
