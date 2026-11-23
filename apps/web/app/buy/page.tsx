import { connection } from "next/server";
import { Suspense } from "react";
import { requireUserId } from "@/lib/server/session";
import { BuyFlow } from "./buy-flow";

async function Gate() {
  await connection();
  await requireUserId();
  return <BuyFlow />;
}

export default function BuyPage() {
  return (
    <div className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="font-display text-4xl tracking-tight text-forest-deep">Buy</h1>
      <p className="mt-3 text-ink-soft">Pick a tokenized US stock and an amount. You see the live price and costs before you approve.</p>
      <div className="mt-10">
        <Suspense fallback={<div className="h-64 rounded-2xl bg-sand" />}>
          <Gate />
        </Suspense>
      </div>
    </div>
  );
}
