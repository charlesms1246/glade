import type { CppiState } from "@glade/engine";
import { decideFloor, type FloorDecision, type FloorDraft, type FloorInputs, type FloorMandate, type FloorParams } from "./decide";

export interface FloorUser {
  userId: string;
  mandate: FloorMandate;
  state: CppiState & { tradesDay: string | null };
}

export interface FloorJobDeps {
  activeUsers: () => Promise<FloorUser[]>;
  inputs: (userId: string) => Promise<FloorInputs | null>;
  /** Users with an unfinished intent are skipped so Floor never stacks orders. */
  hasOpenIntents: (userId: string) => Promise<boolean>;
  insertIntents: (userId: string, drafts: FloorDraft[], d: FloorDecision) => Promise<void>;
  saveState: (userId: string, s: { peak: string; lastTradeAt: Date | null; tradesDay: string; tradesToday: number }) => Promise<void>;
  logDecision: (userId: string, d: FloorDecision) => Promise<void>;
  params: FloorParams;
  /** Kill switch: no new intents while set. */
  paused: () => boolean;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

export async function runFloorJob(deps: FloorJobDeps, now: Date): Promise<{ traded: string[]; idle: string[] }> {
  const traded: string[] = [];
  const idle: string[] = [];
  if (deps.paused()) return { traded, idle };
  for (const u of await deps.activeUsers()) {
    try {
      if (await deps.hasOpenIntents(u.userId)) {
        idle.push(u.userId);
        continue;
      }
      const inp = await deps.inputs(u.userId);
      if (!inp) {
        idle.push(u.userId);
        continue;
      }
      const today = day(now);
      const tradesToday = u.state.tradesDay === today ? u.state.tradesToday : 0;
      const d = decideFloor(u.mandate, { ...u.state, tradesToday }, inp, deps.params, now);
      const peak = d.cppi.peak.toString();
      if (d.drafts.length) {
        await deps.insertIntents(u.userId, d.drafts, d);
        await deps.saveState(u.userId, { peak, lastTradeAt: now, tradesDay: today, tradesToday: tradesToday + 1 });
        await deps.logDecision(u.userId, d);
        traded.push(u.userId);
      } else {
        await deps.saveState(u.userId, { peak, lastTradeAt: u.state.lastTradeAt, tradesDay: today, tradesToday });
        if (d.cppi.floorAtRisk) await deps.logDecision(u.userId, d);
        idle.push(u.userId);
      }
    } catch (e) {
      deps.log?.("floor_user_failed", { userId: u.userId, error: String(e).slice(0, 300) });
    }
  }
  return { traded, idle };
}
