import { connection } from "next/server";
import { Suspense } from "react";
import { requireUserId } from "@/lib/server/session";
import { ActivityFeed } from "./activity-feed";

async function Gate() {
  await connection();
  await requireUserId();
  return <ActivityFeed />;
}

export default function ActivityPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="font-display text-4xl tracking-tight text-forest-deep">Activity</h1>
      <p className="mt-3 text-ink-soft">Every order you approved and every decision Glade&apos;s engine made, in plain English.</p>
      <div className="mt-10">
        <Suspense fallback={<div className="h-40 rounded-2xl bg-sand" />}>
          <Gate />
        </Suspense>
      </div>
    </div>
  );
}
