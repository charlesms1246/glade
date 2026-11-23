// Spike: mint a True Markets org token and inspect it.
// Read-only: no orders, no users, no funds. Never prints the token or key material.
//
//   node scripts/spike-token.ts            # uses TM_ENV from .env
//   TM_ENV=prod node scripts/spike-token.ts

import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";

process.loadEnvFile(".env");
const TM_ENV = process.env.TM_ENV ?? "uat";
const API =
  TM_ENV === "prod" ? "https://api.truemarkets.co" : "https://api.uat.truemarkets.co";

const keyFile = process.env.TM_ORG_KEY_FILE;
if (!keyFile) throw new Error("TM_ORG_KEY_FILE is not set");
const { key_id, private_key } = JSON.parse(readFileSync(keyFile, "utf8"));

const mask = (s: string) => (s.length > 8 ? `${s.slice(0, 8)}…` : "…");

const timestamp = Math.floor(Date.now() / 1000);
const signature = sign("sha256", Buffer.from(`${key_id}.${timestamp}`), {
  key: createPrivateKey({ key: private_key, format: "jwk" }),
  dsaEncoding: "ieee-p1363", // raw r||s, as the API expects
}).toString("base64url");

const t0 = Date.now();
const res = await fetch(`${API}/v1/auth/api-key/token`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ key_id, timestamp, signature }),
});
const latencyMs = Date.now() - t0;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body: any = await res.json().catch(() => ({}));

console.log(`env              ${TM_ENV} (${API})`);
console.log(`status           ${res.status} in ${latencyMs} ms`);

const serverDate = res.headers.get("date");
if (serverDate) {
  const skew = Math.round((Date.now() - Date.parse(serverDate)) / 1000);
  console.log(`clock skew       ~${skew} s vs server (limit ±30 s)`);
}
const rl: [string, string][] = [];
res.headers.forEach((v, k) => {
  if (k.startsWith("x-ratelimit")) rl.push([k, v]);
});
if (rl.length) console.log(`rate limit hdrs  ${rl.map(([k, v]) => `${k}=${v}`).join(" ")}`);

if (!res.ok) {
  console.log(`error            type=${body.type ?? "-"} code=${body.code ?? "-"} request_id=${body.request_id ?? res.headers.get("x-request-id") ?? "-"}`);
  console.log(`message          ${body.message ?? "-"}`);
  process.exit(1);
}

const token: string = body.access_token;
const [header, payload] = token.split(".").slice(0, 2).map((p) => JSON.parse(Buffer.from(p, "base64url").toString()));

console.log(`response fields  ${Object.keys(body).join(", ")}`);
console.log(`refresh_token    ${body.refresh_token ? "present" : "absent"}`);
console.log(`expires_in       ${JSON.stringify(body.expires_in)} (type ${typeof body.expires_in})`);
console.log(`jwt alg          ${header.alg}`);
console.log(`jwt claims       ${Object.keys(payload).join(", ")}`);
if (payload.tm) console.log(`jwt tm claims    ${Object.keys(payload.tm).join(", ")}`);
console.log(`role/token_use   ${payload.role ?? "-"} / ${payload.token_use ?? "-"}`);
console.log(`tm.auth_method   ${payload.tm?.auth_method ?? "-"}   tm.cohort ${payload.tm?.cohort ?? "-"}`);
const orgId: string | undefined = payload.tm?.organization_id;
console.log(`organization_id  ${orgId ? mask(orgId) : "MISSING"}`);
if (payload.iat && payload.exp) console.log(`lifetime         ${Math.round((payload.exp - payload.iat) / 60)} min (iat→exp)`);
