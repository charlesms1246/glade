import { z } from "zod";

const flag = z.enum(["0", "1"]);
const bool01Default0 = flag.default("0").transform((v) => v === "1");
const decStr = z.string().regex(/^\d+(\.\d+)?$/, "must be a non-negative decimal");

export const envSchema = z.object({
  TM_ENV: z.enum(["uat", "prod"]),
  TM_ORG_KEY_FILE: z.string().min(1),
  MAX_ORDER_USD: decStr,
  SIGNER_MASTER_KEY: z
    .string()
    .regex(/^base64:/, "must start with base64:")
    .refine((v) => Buffer.from(v.slice(7), "base64").length === 32, "must decode to 32 bytes"),
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//),
  APP_ORIGIN: z.string().url(),
  WEBAUTHN_RP_ID: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  /** Extra origins whose passkey approvals the worker accepts (comma-separated), e.g. local dev. */
  WEBAUTHN_EXTRA_ORIGINS: z.string().default(""),
  MIN_PERP_NOTIONAL_USD: decStr.default("10"),
  DEFAULT_LEVERAGE: decStr.default("2"),
  FLOOR_COOLDOWN_SEC: z.coerce.number().int().positive().default(600),
  FLOOR_BAND: decStr.default("0.05"),
  FUNDING_MAX_ANNUAL: decStr.default("0.40"),
  GLADE_PAUSE_ALL: bool01Default0,
});

export type Env = z.infer<typeof envSchema>;

/** Parse and validate the environment. Error messages name keys only, never values. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const r = envSchema.safeParse(source);
  if (!r.success) {
    const keys = r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`invalid environment: ${keys}`);
  }
  return r.data;
}

export const TM_BASE_URLS = {
  uat: { rest: "https://api.uat.truemarkets.co", ws: "wss://api.uat.truemarkets.co/v1/defi/market" },
  prod: { rest: "https://api.truemarkets.co", ws: "wss://api.truemarkets.co/v1/defi/market" },
} as const;
