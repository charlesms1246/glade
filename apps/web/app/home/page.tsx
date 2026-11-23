import { connection } from "next/server";
import { Suspense } from "react";
import { requireUserId } from "@/lib/server/session";
import { HomeView } from "./home-view";

async function Gate() {
  await connection();
  await requireUserId();
  return <HomeView />;
}

export default function HomePage() {
  return (
    <div className="mx-auto max-w-5xl px-6 py-16">
      <h1 className="font-display text-4xl tracking-tight text-forest-deep">Your clearing</h1>
      <p className="mt-3 text-ink-soft">Paper portfolio at live prices, and how much of it is protected.</p>
      <div className="mt-10">
        <Suspense fallback={<div className="h-64 rounded-2xl bg-sand" />}>
          <Gate />
        </Suspense>
      </div>
    </div>
  );
}
