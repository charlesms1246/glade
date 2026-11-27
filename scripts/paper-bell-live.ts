// Places a PAPER "Shield until the bell" through the deployed web app, the same path a user takes:
// passkey sign-in, Bell plan, passkey approval. The deployed worker then opens the short and closes it
// at the next open + 5 min. Run only while the market is closed. No real money.
//   pnpm exec tsx scripts/paper-bell-live.ts --name demo-1 --ratio 0.5 [--base https://glade-app-iota.vercel.app]
// The software passkey row stays registered: the worker re-verifies the approval when it closes the hedge.
import { existsSync } from "node:fs";
import { createDb, schema } from "@glade/db";
import { loadEnv } from "@glade/shared";
import { eq } from "drizzle-orm";
import { createSoftPasskey } from "./lib/soft-passkey";

if (existsSync(".env")) process.loadEnvFile(".env");
const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
};
const name = arg("name", "demo-1");
const ratio = arg("ratio", "0.5");
const base = new URL(arg("base", "https://glade-app-iota.vercel.app"));
const env = loadEnv();
const { db, sql } = createDb(env.DATABASE_URL, { max: 1 });

const cookies = new Map<string, string>();
async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(new URL(path, base), {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", origin: base.origin, cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; ") },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const c of res.headers.getSetCookie()) {
    const [kv] = c.split(";");
    const at = kv!.indexOf("=");
    cookies.set(kv!.slice(0, at), kv!.slice(at + 1));
  }
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(`${path}: ${res.status} ${json.error ?? ""}`);
  return json;
}

try {
  const [user] = await db.select().from(schema.appUsers).where(eq(schema.appUsers.displayName, name));
  if (!user) throw new Error(`no app user ${name}`);
  const passkey = createSoftPasskey(base.hostname, base.origin);
  await db.insert(schema.passkeys).values({ userId: user.id, credentialId: passkey.credentialId, publicKey: passkey.cosePublicKey, counter: 0 });

  const login = await call<{ challenge: string }>("/api/auth/login/options", {});
  await call("/api/auth/login/verify", passkey.assert(login.challenge));
  console.log(`ok   signed in as ${name}`);

  const offer = await call<{ plan: { legs: { symbol: string; side: string; qty: string; notionalUsd: string; reduceOnly: boolean }[]; unwindAt: string }; tag: string; passkey: { challenge: string } }>(
    "/api/shield/plan",
    { ratio, kind: "bell" },
  );
  for (const l of offer.plan.legs) console.log(`     ${l.reduceOnly ? "close" : "open "} ${l.side} ${l.qty} ${l.symbol} perp (~${l.notionalUsd} USD)`);
  const { hedgeId } = await call<{ hedgeId: string }>("/api/shield/confirm", { plan: offer.plan, tag: offer.tag, assertion: passkey.assert(offer.passkey.challenge) });
  console.log(`ok   Bell hedge ${hedgeId} approved; unwinds at ${offer.plan.unwindAt}`);
} finally {
  await sql.end({ timeout: 5 });
}
