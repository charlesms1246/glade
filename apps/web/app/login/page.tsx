import { AuthPanel } from "./auth-panel";

export default function LoginPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="font-display text-4xl tracking-tight text-forest-deep">Sign in</h1>
      <p className="mt-3 max-w-xl text-ink-soft">Glade runs on paper trading: balances and fills are simulated at live True Markets prices. No real money moves.</p>
      <div className="mt-10">
        <AuthPanel />
      </div>
    </div>
  );
}
