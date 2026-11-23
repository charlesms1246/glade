"use client";

import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, errText } from "@/lib/client/http";

export function AuthPanel() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<{ next: string }>) {
    setBusy(true);
    setError(null);
    try {
      router.push((await fn()).next);
      router.refresh();
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  }

  const register = () =>
    run(async () => {
      const optionsJSON = await api<Parameters<typeof startRegistration>[0]["optionsJSON"]>("/api/auth/register/options", { name });
      return api("/api/auth/register/verify", await startRegistration({ optionsJSON }));
    });

  const login = () =>
    run(async () => {
      const optionsJSON = await api<Parameters<typeof startAuthentication>[0]["optionsJSON"]>("/api/auth/login/options", {});
      return api("/api/auth/login/verify", await startAuthentication({ optionsJSON }));
    });

  return (
    <div className="grid gap-6 sm:grid-cols-2">
      <form
        className="rounded-2xl bg-sand p-7"
        onSubmit={(e) => {
          e.preventDefault();
          void register();
        }}
      >
        <h2 className="font-display text-2xl text-forest-deep">New to Glade</h2>
        <p className="mt-2 text-sm text-ink-soft">Create a passkey. No password, no email. You get a paper account to practise with.</p>
        <label className="mt-5 block text-sm font-medium" htmlFor="name">
          Display name
        </label>
        <input
          id="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={40}
          required
          className="mt-2 w-full rounded-xl border border-sand-deep bg-paper px-4 py-3 outline-none focus:border-forest"
          placeholder="e.g. Alex"
        />
        <button disabled={busy || !name.trim()} className="mt-5 w-full rounded-full bg-forest px-6 py-3 text-sm font-medium text-paper hover:bg-forest-deep disabled:opacity-50">
          Create passkey
        </button>
      </form>
      <div className="rounded-2xl border border-sand-deep p-7">
        <h2 className="font-display text-2xl text-forest-deep">Welcome back</h2>
        <p className="mt-2 text-sm text-ink-soft">Sign in with the passkey you created on this device or synced to it.</p>
        <button onClick={() => void login()} disabled={busy} className="mt-5 w-full rounded-full border border-forest/30 px-6 py-3 text-sm font-medium text-forest hover:bg-sand disabled:opacity-50">
          Sign in with passkey
        </button>
      </div>
      {error && <p role="alert" className="text-sm text-rose sm:col-span-2">{error}</p>}
    </div>
  );
}
