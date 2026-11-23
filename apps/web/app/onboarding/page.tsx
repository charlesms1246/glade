import { connection } from "next/server";
import { Suspense } from "react";
import { requireUserId } from "@/lib/server/session";
import { OnboardingStatus } from "./onboarding-status";

async function Gate() {
  await connection();
  await requireUserId();
  return <OnboardingStatus />;
}

export default function OnboardingPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="font-display text-4xl tracking-tight text-forest-deep">Welcome to Glade</h1>
      <p className="mt-3 max-w-xl text-ink-soft">Your passkey is set. One moment while your paper account is prepared.</p>
      <div className="mt-10">
        <Suspense fallback={<div className="h-40 rounded-2xl bg-sand" />}>
          <Gate />
        </Suspense>
      </div>
    </div>
  );
}
