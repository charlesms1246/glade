import type { Db } from "@glade/db";
import { schema } from "@glade/db";
import { ENGINE_VERSION, normalizeSymbol } from "@glade/engine";
import { createPaperVenue, drizzlePaperRepo, drizzleRegistry, paperUsersWithPositions } from "@glade/paper";
import { dec, Decimal, type Env } from "@glade/shared";
import { parseMasterKey } from "@glade/stamp";
import type { TmClient, TokenManager } from "@glade/tm-client";
import { and, eq } from "drizzle-orm";
import type { Logger } from "pino";
import { activeFloorUsers, hasOpenIntents, insertFloorIntents, pendingOnboarding, saveFloorState } from "./db/floor";
import { claimIntents, dueBellHedges, insertCloseIntents, policyQueries, reclaimStale, recordIntentResult } from "./db/intents";
import { executorRepo, logDecision, onboardingRepo, publish } from "./db/repos";
import { createExecutor } from "./executor";
import { unwindDrafts } from "./jobs/bell-unwind";
import { runPendingIntents, type ClaimedIntent } from "./jobs/intent-runner";
import { runOnboardingJob } from "./jobs/onboarding-job";
import { runFloorJob } from "./floor/job";
import { ratesFromAssets, runFundingJob } from "./funding/job";
import type { PriceCache } from "./market/price-cache";
import type { MarketStream } from "./market/stream";
import { loadSigner, onboardUser } from "./onboarding/onboard";
import { authorizeIntent } from "./policy/authorize";

/** Paper USDC credited to each new account. No real money is ever involved. */
export const PAPER_START_USD = "10000";
const PRICE_MAX_AGE_MS = 60_000;
const PERP_SIZE_STEP = "0.001";
const STALE_INTENT_MS = 3 * 60_000;

export interface TradingDeps {
  db: Db;
  tm: TmClient;
  tokens: TokenManager | undefined;
  env: Env;
  cache: PriceCache;
  stream: MarketStream;
  log: Logger;
}

/** Wires the paper venue, executor and the worker's trading jobs. Returns a stop function. */
export function startTrading(d: TradingDeps): () => void {
  const { db, tm, env, cache, stream, log } = d;
  const masterKey = parseMasterKey(env.SIGNER_MASTER_KEY);

  // Live price for the paper venue: WebSocket cache first, REST otherwise. Newly seen symbols get subscribed.
  const prices = async (symbol: string, cls: "spot" | "perp"): Promise<Decimal> => {
    const q = cache.fresh(symbol, cls, new Date(), PRICE_MAX_AGE_MS);
    if (q) return q.px;
    stream.watch([{ symbol, cls }]);
    const r = await tm.prices(symbol, cls);
    const px = r.candles?.find((c) => c.interval === "1h")?.closePrice ?? r.candles?.[0]?.closePrice;
    if (!px) throw new Error(`no ${cls} price for ${symbol}`);
    cache.set(symbol, cls, px, new Date(), "rest");
    return dec(px);
  };

  const registry = drizzleRegistry(db, env.TM_ENV);
  const venue = createPaperVenue({ repo: drizzlePaperRepo(db), prices, registry });
  const policy = policyQueries(db);
  const onboarding = onboardingRepo(db);

  const riskyValue = async (userId: string) => {
    const p = await venue.forUser(userId).portfolio();
    return p.balances.filter((b) => !b.stable).reduce((a, b) => a.plus(dec(b.value ?? "0")), new Decimal(0)).toString();
  };

  // The executor's policy callback sees only the ExecIntent; the full stored row is looked up here.
  const inFlight = new Map<string, ClaimedIntent>();
  const verifiedMandates = new Set<string>();
  const executor = createExecutor(venue, {
    repo: executorRepo(db),
    signerFor: (userId) => loadSigner(onboarding, masterKey, userId),
    authorize: async (ei) => {
      const row = inFlight.get(ei.id);
      if (!row) return { ok: false, reasons: ["intent not claimed by this worker"] };
      return authorizeIntent(
        row,
        {
          env: "paper",
          maxOrderUsd: env.MAX_ORDER_USD,
          userLeverageCap: "3",
          origin: env.APP_ORIGIN,
          rpID: env.WEBAUTHN_RP_ID,
          getPasskey: policy.getPasskey,
          getActiveMandate: policy.getActiveMandate,
          tradesToday: policy.tradesToday,
          riskyValue,
          verifiedMandates,
        },
        new Date(),
      );
    },
    config: { venue: "paper", tmEnv: env.TM_ENV, maxOrderUsd: env.MAX_ORDER_USD },
    log: (event, fields) => log.info(fields, event),
  });

  const execute = async (i: ClaimedIntent) => {
    inFlight.set(i.id, i);
    try {
      const notionalUsd = String((i.inputs as { notionalUsd?: string } | null)?.notionalUsd ?? "0");
      return await executor.execute({
        id: i.id,
        userId: i.userId,
        venueUserId: i.userId,
        assetId: i.assetId,
        side: i.side,
        qty: i.qty,
        qtyUnit: i.qtyUnit,
        leverage: i.leverage === null ? null : Number(i.leverage),
        reduceOnly: i.reduceOnly,
        notionalUsd,
        venue: "defi",
      });
    } finally {
      inFlight.delete(i.id);
    }
  };

  const runnerDeps = (claim: (n: number) => Promise<ClaimedIntent[]>) => ({
    claim,
    execute,
    onResult: (i: ClaimedIntent, r: Awaited<ReturnType<typeof execute>>) => recordIntentResult(db, ENGINE_VERSION, i, r),
    log: (event: string, fields: Record<string, unknown>) => log.warn(fields, event),
  });

  const perpsList = async () => {
    const r = schema.assetRegistry;
    return db
      .select({ asset_id: r.assetId, symbol: r.symbol, max_leverage: r.maxLeverage })
      .from(r)
      .where(and(eq(r.env, env.TM_ENV), eq(r.type, "perp")));
  };

  const floorInputs = async (userId: string) => {
    const u = venue.forUser(userId);
    const [p, pos, perps] = await Promise.all([u.portfolio(), u.positions(), perpsList()]);
    const holdings = p.balances
      .filter((b) => !b.stable && b.asset_id && b.economic_asset_id && b.value)
      .map((b) => ({ asset_id: b.asset_id!, economic_asset_id: b.economic_asset_id!, symbol: b.symbol, value: b.value! }));
    if (holdings.length === 0) return null;
    const wanted = new Set([...holdings.map((h) => normalizeSymbol(h.symbol)), "SP500", "XYZ100"]);
    const marks: Record<string, string> = {};
    for (const pr of perps.filter((x) => wanted.has(x.symbol.toUpperCase()))) {
      try {
        marks[pr.asset_id] = (await prices(pr.symbol, "perp")).toString();
      } catch {
        // A perp without a price is skipped by the decision.
      }
    }
    return {
      equity: p.total_usd ?? "0",
      holdings,
      positions: pos.positions
        .filter((x) => x.side === "short" && x.asset_id && x.size && x.mark_price)
        .map((x) => ({ asset_id: x.asset_id!, size: x.size!, mark_price: x.mark_price! })),
      perps: perps.map((x) => ({ asset_id: x.asset_id, symbol: x.symbol, ...(x.max_leverage ? { max_leverage: x.max_leverage } : {}) })),
      marks,
    };
  };

  const busy = new Set<string>();
  const every = (name: string, ms: number, fn: () => Promise<unknown>) => {
    const run = async () => {
      if (busy.has(name)) return;
      busy.add(name);
      try {
        await fn();
      } catch (e) {
        log.error({ job: name, error: String(e).slice(0, 300) }, "job_failed");
      } finally {
        busy.delete(name);
      }
    };
    void run();
    return setInterval(run, ms);
  };

  const paused = () => env.GLADE_PAUSE_ALL;
  const timers = [
    every("intents", 3_000, async () => {
      if (paused()) return;
      const done = await runPendingIntents(runnerDeps((n) => claimIntents(db, n)));
      if (done.length) log.info({ results: done.map((r) => r.outcome) }, "intents_run");
    }),
    every("reconcile", 60_000, async () => {
      if (paused()) return;
      await runPendingIntents(runnerDeps((n) => reclaimStale(db, STALE_INTENT_MS, n)));
    }),
    every("bell_unwind", 15_000, async () => {
      for (const h of await dueBellHedges(db, new Date())) {
        const drafts = unwindDrafts(h);
        await insertCloseIntents(db, drafts);
        log.info({ hedgeId: h.hedgeId, legs: drafts.length }, "bell_unwind_queued");
      }
    }),
    every("floor", 30_000, () =>
      runFloorJob(
        {
          activeUsers: () => activeFloorUsers(db),
          inputs: floorInputs,
          hasOpenIntents: (u) => hasOpenIntents(db, u),
          insertIntents: (u, drafts, dec_) => insertFloorIntents(db, u, drafts, dec_),
          saveState: (u, s) => saveFloorState(db, u, s),
          logDecision: (u, dec_) =>
            logDecision(db, { userId: u, engineVersion: ENGINE_VERSION, action: dec_.drafts.length ? "floor_rebalance" : "floor_at_risk", explanation: dec_.explanation, inputs: { skipped: dec_.skipped }, outputs: { drafts: dec_.drafts, floor: dec_.cppi.floor.toString(), cushionRatio: dec_.cppi.cushionRatio.toString() } }).then(() =>
              publish(db, { type: "floor", data: { userId: u, explanation: dec_.explanation } }),
            ),
          params: { band: String(env.FLOOR_BAND), cooldownSec: env.FLOOR_COOLDOWN_SEC, minNotionalUsd: String(env.MIN_PERP_NOTIONAL_USD), leverage: String(env.DEFAULT_LEVERAGE), sizeStep: () => PERP_SIZE_STEP },
          paused,
          log: (event, fields) => log.warn(fields, event),
        },
        new Date(),
      ),
    ),
  ];

  timers.push(
    every("funding", 5 * 60_000, async () => {
      const r = await runFundingJob(
        {
          users: () => paperUsersWithPositions(db),
          hourlyRates: async () => ratesFromAssets(await tm.listAssets({ product_type: "perp" })),
          accrue: venue.accrueFunding,
          log: (event, fields) => log.warn(fields, event),
        },
        new Date(),
      );
      if (r.credited.length) log.info({ users: r.credited.length }, "funding_settled");
    }),
  );

  if (d.tokens) {
    timers.push(
      every("onboarding", 5_000, async () => {
        const r = await runOnboardingJob({
          pending: (n) => pendingOnboarding(db, n),
          onboard: (userId) => onboardUser({ tm, repo: onboarding, masterKey, env: env.TM_ENV }, userId),
          fundPaper: async (userId) => void (await venue.ensurePaperAccount(userId, PAPER_START_USD)),
          record: (userId, rec) =>
            logDecision(db, { userId, engineVersion: ENGINE_VERSION, action: "onboarded", explanation: `Account ready with ${PAPER_START_USD} paper USDC (no real money).`, inputs: {}, outputs: { tmUserId: rec.tmUserId } }),
          log: (event, fields) => log.warn(fields, event),
        });
        if (r.done.length) log.info({ users: r.done.length }, "onboarded");
      }),
    );
  } else {
    log.warn("onboarding disabled: no organization token");
  }

  return () => timers.forEach(clearInterval);
}
