import bell from "../../../../../docs/evidence/bell-calibration-NVDA.json";
import r30 from "../../../../../docs/evidence/replay-NVDA-30d-f0.85.json";
import r30ratchet from "../../../../../docs/evidence/replay-NVDA-30d-f0.9-ratchet.json";
import r90 from "../../../../../docs/evidence/replay-NVDA-90d-f0.85.json";

const EVIDENCE: Record<string, unknown> = {
  "bell-calibration-NVDA.json": bell,
  "replay-NVDA-30d-f0.85.json": r30,
  "replay-NVDA-30d-f0.9-ratchet.json": r30ratchet,
  "replay-NVDA-90d-f0.85.json": r90,
};

/** The evidence files produced from live public market data, served as JSON. */
export async function GET(_req: Request, ctx: RouteContext<"/evidence/[name]">) {
  const data = EVIDENCE[(await ctx.params).name];
  return data ? Response.json(data) : Response.json({ error: "not found" }, { status: 404 });
}
