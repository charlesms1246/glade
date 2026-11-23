import { connection } from "next/server";
import { Suspense } from "react";
import { requireUserId } from "@/lib/server/session";
import { FloorFlow } from "./floor-flow";

async function Gate() {
  await connection();
  await requireUserId();
  return <FloorFlow />;
}

export default function FloorPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="font-display text-4xl tracking-tight text-forest-deep">Floor</h1>
      <p className="mt-3 max-w-2xl text-ink-soft">
        Sign a mandate once. Glade then adjusts a short hedge on your behalf to keep your equity above a target you choose,
        within limits your passkey signed.
      </p>
      <div className="mt-10">
        <Suspense fallback={<div className="h-64 rounded-2xl bg-sand" />}>
          <Gate />
        </Suspense>
      </div>
    </div>
  );
}
