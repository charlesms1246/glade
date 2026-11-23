import { connection } from "next/server";
import { Suspense } from "react";
import { requireUserId } from "@/lib/server/session";
import { ShieldFlow } from "./shield-flow";

async function Gate() {
  await connection();
  await requireUserId();
  return <ShieldFlow />;
}

export default function ShieldPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="font-display text-4xl tracking-tight text-forest-deep">Shield</h1>
      <p className="mt-3 max-w-2xl text-ink-soft">
        Offset part of your stock exposure with a short perpetual. You see every leg, its margin, liquidation estimate,
        funding and fees before you approve with your passkey.
      </p>
      <div className="mt-10">
        <Suspense fallback={<div className="h-64 rounded-2xl bg-sand" />}>
          <Gate />
        </Suspense>
      </div>
    </div>
  );
}
