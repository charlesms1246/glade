import type { Db } from "@glade/db";
import { schema } from "@glade/db";
import type { ClosureKind } from "@glade/calendar";
import { ENGINE_VERSION, normalizeSymbol, referenceSpotSymbol } from "@glade/engine";
import { createPaperVenue, drizzlePaperRepo, drizzleRegistry, paperUsersWithPositions } from "@glade/paper";
import { dec, Decimal, type Env } from "@glade/shared";
import { parseMasterKey } from "@glade/stamp";
import { TmApiError, type TmClient, type TokenManager } from "@glade/tm-client";
import { and, eq } from "drizzle-orm";
import type { Logger } from "pino";
import { activeFloorUsers, floorHedgeSizes, hasOpenIntents, insertFloorIntents, pendingOnboarding, saveFloorState } from "./db/floor";
import { claimIntents, dueBellHedges, insertCloseIntents, MAX_CLOSE_ATTEMPTS, policyQueries, reclaimStale, recordIntentResult } from "./db/intents";
import { executorRepo, logDecision, onboardingRepo, publish } from "./db/repos";
import { createExecutor } from "./executor";
import { bellReportDb } from "./bell-report/db";
import { runBellReportJob } from "./bell-report/job";
import { unwindDrafts } from "./jobs/bell-unwind";
import { runPendingIntents, type ClaimedIntent } from "./jobs/intent-runner";
import { runOnboardingJob } from "./jobs/onboarding-job";
import { runFloorJob } from "./floor/job";
import { ratesFromAssets, runFundingJob } from "./funding/job";
import type { PriceCache } from "./market/price-cache";
import type { MarketStream } from "./market/stream";
import { ensureSigner, loadSigner, onboardUser } from "./onboarding/onboard";
import { authorizeIntent } from "./policy/authorize";

/** Paper USDC credited to each new account. No real money is ever involved. */
export const PAPER_START_USD = "10000";
const PRICE_MAX_AGE_MS = 60_000;
const PERP_SIZE_STEP = "0.001";
const STALE_INTENT_MS = 3 * 60_000;
const GATEWAY_BACKOFF_MS = 60 * 60_000;
const MAX_PAPER_ACCOUNTS_PER_DAY = 200;

export interface TradingDeps {
  db: Db;
  tm: TmClient;
  tokens: TokenManager | undefined;
  env: Env;
  cache: PriceCache;
  stream: MarketStream;
  log: Logger;
  /** Calibrated σ of the Bell estimate by closure kind. */
  sigma: Record<ClosureKind, Decimal>;
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
  // Passkey approvals are accepted from the web app's origin plus any extra (e.g. local dev) origins.
  const origins = [env.APP_ORIGIN, ...env.WEBAUTHN_EXTRA_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean)];
  const rpIDs = [...new Set([env.WEBAUTHN_RP_ID, ...origins.slice(1).map((o) => new URL(o).hostname)])];
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
          origin: origins,
          rpID: rpIDs,
          getPasskey: policy.getPasskey,
          getActiveMandate: policy.getActiveMandate,
          tradesToday: policy.tradesToday,
          riskyValue,
          assetType: policy.assetType,
          liveSiblings: policy.liveSiblings,
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
    const [p, pos, perps, own] = await Promise.all([u.portfolio(), u.positions(), perpsList(), floorHedgeSizes(db, userId)]);
    const holdings = p.balances
      .filter((b) => !b.stable && b.asset_id && b.economic_asset_id && b.value)
      .map((b) => ({ asset_id: b.asset_id!, economic_asset_id: b.economic_asset_id!, symbol: b.symbol, value: b.value! }));
    if (holdings.length === 0) return null;
    const bases = new Set(perps.map((x) => x.symbol.toUpperCase()));
    const wanted = new Set([...holdings.map((h) => normalizeSymbol(h.symbol, bases)), "SP500", "XYZ100"]);
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
      // Only the Floor's own share of each short, never more than the actual position.
      positions: pos.positions
        .filter((x) => x.side === "short" && x.asset_id && x.size && x.mark_price && own[x.asset_id])
        .map((x) => ({
          asset_id: x.asset_id!,
          size: Decimal.max(0, Decimal.min(dec(own[x.asset_id!]!), dec(x.size!))).toString(),
          mark_price: x.mark_price!,
        }))
        .filter((x) => dec(x.size).gt(0)),
      perps: perps.map((x) => ({ asset_id: x.asset_id, symbol: x.symbol, ...(x.max_leverage ? { max_leverage: x.max_leverage } : {}) })),
      marks,
    };
  };

  const busy = new Set<string>();
  // `lock` lets jobs share one mutex: the intent runner and the reconciler both execute orders.
  const every = (name: string, ms: number, fn: () => Promise<unknown>, lock = name) => {
    const run = async () => {
      if (busy.has(lock)) return;
      busy.add(lock);
      try {
        await fn();
      } catch (e) {
        log.error({ job: name, error: String(e).slice(0, 300) }, "job_failed");
      } finally {
        busy.delete(lock);
      }
    };
    void run();
    return setInterval(run, ms);
  };

  const paused = () => env.GLADE_PAUSE_ALL;
  const atRiskLoggedAt = new Map<string, number>();
  const alerted = new Set<string>();
  const timers = [
    every(
      "intents",
      3_000,
      async () => {
        if (paused()) return;
        // One at a time, so no claimed intent waits long enough to look stale to the reconciler.
        const done = await runPendingIntents(runnerDeps((n) => claimIntents(db, n)), 1);
        if (done.length) log.info({ results: done.map((r) => r.outcome) }, "intents_run");
      },
      "execution",
    ),
    every(
      "reconcile",
      60_000,
      async () => {
        if (paused()) return;
        await runPendingIntents(runnerDeps((n) => reclaimStale(db, STALE_INTENT_MS, n)));
      },
      "execution",
    ),
    every("bell_unwind", 15_000, async () => {
      for (const h of await dueBellHedges(db, new Date())) {
        const drafts = unwindDrafts(h);
        if (drafts.length === 0) {
          // Every filled leg is closed (or none filled): the hedge is done.
          await db.update(schema.hedges).set({ status: "closed", closedAt: new Date() }).where(eq(schema.hedges.id, h.hedgeId));
          continue;
        }
        if (h.failedCloses >= MAX_CLOSE_ATTEMPTS * Math.max(1, h.doneOpens.length)) {
          if (!alerted.has(h.hedgeId)) {
            alerted.add(h.hedgeId);
            await logDecision(db, { userId: h.userId, engineVersion: ENGINE_VERSION, action: "bell_unwind_stuck", explanation: `Shield until the bell could not close ${drafts.length} leg(s) after ${MAX_CLOSE_ATTEMPTS} attempts. The hedge is still open; unshield it manually.`, inputs: { hedgeId: h.hedgeId }, outputs: { failedCloses: h.failedCloses } });
            await publish(db, { type: "intent", data: { userId: h.userId, intentId: null, outcome: "failed", explanation: "Shield until the bell could not close; unshield manually." } });
          }
          continue;
        }
        await insertCloseIntents(db, drafts);
        log.info({ hedgeId: h.hedgeId, legs: drafts.length, retry: h.failedCloses > 0 }, "bell_unwind_queued");
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
          atRiskLoggedAt,
          log: (event, fields) => log.warn(fields, event),
        },
        new Date(),
      ),
    ),
  ];

  // Spot reads for Bell reports use a listed issuer symbol (e.g. AAPLC for AAPL).
  let spotSymbols: string[] | undefined;
  const spotSymbolFor = async (group: string) => {
    if (!spotSymbols) {
      const r = schema.assetRegistry;
      spotSymbols = (await db.select({ s: r.symbol }).from(r).where(and(eq(r.env, env.TM_ENV), eq(r.type, "spot"), eq(r.assetClass, "stock")))).map((x) => x.s);
    }
    return referenceSpotSymbol(group, spotSymbols) ?? group;
  };

  timers.push(
    every("bell_report", 60_000, async () => {
      const r = await runBellReportJob(
        {
          ...bellReportDb(db),
          spotPriceAt: async (symbol, at) => {
            const h = await tm.priceHistory({ symbol: await spotSymbolFor(symbol), window: "15m", resolution: "1m", asOf: new Date(at.getTime() + 1).toISOString() });
            return h.points?.at(-1)?.price ?? null;
          },
          logDecision: (userId, x) => logDecision(db, { userId, engineVersion: ENGINE_VERSION, ...x }),
          sigma: d.sigma,
          log: (event, fields) => log.warn(fields, event),
        },
        new Date(),
      );
      if (r.reported.length) log.info({ hedges: r.reported }, "bell_reported");
    }),
  );

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

  // Paper-first onboarding. Gateway users are linked when the org allows; refusals back off for an hour.
  let gatewayBackoffUntil = 0;
  let budgetDay = "";
  let paperToday = 0;
  timers.push(
    every("onboarding", 5_000, async () => {
      const today = new Date().toISOString().slice(0, 10);
      if (today !== budgetDay) {
        budgetDay = today;
        paperToday = 0;
      }
      const r = await runOnboardingJob({
        pending: (n, gw) => pendingOnboarding(db, n, gw),
        ensureSigner: async (userId) => void (await ensureSigner({ repo: onboarding, masterKey, env: env.TM_ENV }, userId)),
        ensurePaper: async (userId) => {
          const created = await venue.ensurePaperAccount(userId, PAPER_START_USD);
          if (created) paperToday++;
          return created;
        },
        createGateway: (userId) => onboardUser({ tm, repo: onboarding, masterKey, env: env.TM_ENV }, userId),
        gatewayAllowed: () => Boolean(d.tokens) && Date.now() >= gatewayBackoffUntil,
        isGatewayRefusal: (e) => e instanceof TmApiError && e.status === 422 && /user limit/i.test(e.message),
        onGatewayRefused: (e) => {
          gatewayBackoffUntil = Date.now() + GATEWAY_BACKOFF_MS;
          log.warn({ requestId: e instanceof TmApiError ? e.requestId : undefined, retryAt: new Date(gatewayBackoffUntil).toISOString() }, "gateway_user_limit_reached");
        },
        paperBudget: () => MAX_PAPER_ACCOUNTS_PER_DAY - paperToday,
        record: (userId, event, rec) =>
          logDecision(db, {
            userId,
            engineVersion: ENGINE_VERSION,
            action: event === "paper_ready" ? "onboarded" : "gateway_linked",
            explanation:
              event === "paper_ready"
                ? `Account ready with ${PAPER_START_USD} paper USDC (no real money).`
                : "Linked to a True Markets Gateway user with its own signer key.",
            inputs: {},
            outputs: rec ? { tmUserId: rec.tmUserId } : {},
          }),
        log: (event, fields) => log.warn(fields, event),
      });
      if (r.ready.length || r.linked.length) log.info({ ready: r.ready.length, linked: r.linked.length }, "onboarding");
    }),
  );

  return () => timers.forEach(clearInterval);
}
