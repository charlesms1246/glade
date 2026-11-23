import createClient from "openapi-fetch";
import type { z } from "zod";
import { TmApiError } from "./errors";
import type { paths as AccountPaths } from "./generated/account";
import type { components as GatewayComponents, paths as GatewayPaths } from "./generated/gateway";
import type { paths as MarketPaths } from "./generated/marketdata";
import { createTmFetch, type HttpOptions } from "./http";
import * as s from "./schemas";
import type { TokenManager } from "./token";

export type CreateOrderRequest = GatewayComponents["schemas"]["CreateOrderRequest"];
type FetchResult = { data?: unknown; error?: unknown; response: Response };

function unwrap<T extends z.ZodTypeAny>(r: FetchResult, schema: T, method: string, path: string): z.infer<T> {
  if (!r.response.ok || r.error !== undefined) throw new TmApiError(r.response.status, r.error, method, path);
  return schema.parse(r.data);
}

const onBehalfOf = (userId: string) => ({ "TM-On-Behalf-Of": userId });

export interface TmClientOptions extends Omit<HttpOptions, "tokens"> {
  restBase: string;
  /** Required for authenticated routes; public market/asset reads work without it. */
  tokens?: TokenManager;
}

/** The only place Glade talks to True Markets. */
export function createTmClient(opts: TmClientOptions) {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const authed = createTmFetch({ ...opts, ...(opts.tokens ? { tokens: opts.tokens } : {}) });
  const anon = createTmFetch({ ...opts, tokens: undefined });

  const gateway = createClient<GatewayPaths>({ baseUrl: `${opts.restBase}/v1/gateway`, fetch: authed });
  const publicGateway = createClient<GatewayPaths>({ baseUrl: `${opts.restBase}/v1/gateway`, fetch: anon });
  const account = createClient<AccountPaths>({ baseUrl: `${opts.restBase}/v1/account`, fetch: authed });
  const market = createClient<MarketPaths>({ baseUrl: opts.restBase, fetch: anon });

  const requireTokens = () => {
    if (!opts.tokens) throw new Error("this call needs an org token (no TokenManager configured)");
    return opts.tokens;
  };

  return {
    // ---- public reads ------------------------------------------------------
    async listAssets(query: { asset_class?: "crypto" | "stock"; product_type?: "spot" | "perp"; cursor?: string } = {}) {
      const out: s.AssetItem[] = [];
      let cursor = query.cursor;
      for (let page = 0; page < 50; page++) {
        const r = await publicGateway.GET("/assets", { params: { query: { ...query, ...(cursor ? { cursor } : {}) } as never } });
        const body = unwrap(r, s.listAssetsResponse, "GET", "/assets");
        out.push(...(body.data ?? []));
        cursor = body.pagination?.next_cursor ?? undefined;
        if (!cursor) break;
      }
      return out;
    },

    async restrictions() {
      const r = await publicGateway.GET("/assets/restrictions");
      if (!r.response.ok) throw new TmApiError(r.response.status, r.error, "GET", "/assets/restrictions");
      return r.data;
    },

    async prices(symbol: string, assetClass: "spot" | "perp" = "spot") {
      const r = await market.GET("/v1/defi/market/prices", { params: { query: { symbol, asset_class: assetClass } } });
      return unwrap(r, s.priceResponse, "GET", "/v1/defi/market/prices");
    },

    async priceHistory(q: { symbol: string; window: string; resolution: string; assetClass?: "spot" | "perp"; asOf?: string }) {
      const r = await market.GET("/v1/defi/market/prices/history", {
        params: {
          query: {
            symbol: q.symbol,
            window: q.window,
            resolution: q.resolution,
            ...(q.assetClass ? { asset_class: q.assetClass } : {}),
            ...(q.asOf ? { as_of: q.asOf } : {}),
          },
        },
      });
      return unwrap(r, s.historyResponse, "GET", "/v1/defi/market/prices/history");
    },

    async perpHistory(q: { symbol: string; window: string; resolution: string }) {
      const r = await market.GET("/v1/defi/market/market-data/perp/history", { params: { query: q } });
      return unwrap(r, s.perpHistoryResponse, "GET", "/v1/defi/market/market-data/perp/history");
    },

    // ---- org-scoped (never send TM-On-Behalf-Of) ---------------------------
    async organizationId() {
      return requireTokens().organizationId();
    },

    /** Idempotent on external_ref_id; a 503 means wallets aren't ready, so repeat the same request. */
    async createUser(body: { external_ref_id: string; signer_public_key: string }, retries = 5) {
      const orgId = await requireTokens().organizationId();
      for (let attempt = 1; ; attempt++) {
        const r = await account.POST("/organizations/{organization_id}/users", {
          params: { path: { organization_id: orgId } },
          body,
        });
        if (r.response.status === 503 && attempt < retries) {
          await sleep(2000);
          continue;
        }
        const user = unwrap(r, s.createUserResponse, "POST", "/organizations/{organization_id}/users");
        if (user.wallets.length === 0 && attempt < retries) {
          await sleep(2000);
          continue;
        }
        return user;
      }
    },

    async orgTransactions(query: Record<string, string> = {}) {
      const orgId = await requireTokens().organizationId();
      const r = await gateway.GET("/organizations/{organization_id}/transactions", {
        params: { path: { organization_id: orgId }, query: query as never },
      });
      if (!r.response.ok) throw new TmApiError(r.response.status, r.error, "GET", "/organizations/{id}/transactions");
      return r.data;
    },

    // ---- user-scoped (always TM-On-Behalf-Of) ------------------------------
    forUser(userId: string) {
      requireTokens();
      const headers = onBehalfOf(userId);
      return {
        async availability() {
          const r = await gateway.GET("/assets/availability", { headers });
          if (!r.response.ok) throw new TmApiError(r.response.status, r.error, "GET", "/assets/availability");
          return r.data;
        },
        async portfolio() {
          return unwrap(await gateway.GET("/portfolio", { headers }), s.portfolioResponse, "GET", "/portfolio");
        },
        async positions() {
          return unwrap(await gateway.GET("/positions", { headers }), s.positionsResponse, "GET", "/positions");
        },
        async balances() {
          const r = await gateway.GET("/balances", { headers });
          if (!r.response.ok) throw new TmApiError(r.response.status, r.error, "GET", "/balances");
          return r.data;
        },
        async createOrder(body: CreateOrderRequest) {
          return unwrap(await gateway.POST("/orders", { headers, body }), s.createOrderResponse, "POST", "/orders");
        },
        async executeOrder(orderId: string, signatures: string[]) {
          const r = await gateway.POST("/orders/{id}/execute", {
            headers,
            params: { path: { id: orderId } },
            body: { signatures, auth_type: "api_key" },
          });
          if (!r.response.ok) throw new TmApiError(r.response.status, r.error, "POST", "/orders/{id}/execute");
          return r.data;
        },
        async getOrder(orderId: string) {
          const r = await gateway.GET("/orders/{id}", { headers, params: { path: { id: orderId } } });
          return unwrap(r, s.orderDetail, "GET", "/orders/{id}");
        },
        async cancelOrder(orderId: string) {
          const r = await gateway.POST("/orders/{id}/cancel", { headers, params: { path: { id: orderId } } });
          return unwrap(r, s.createOrderResponse, "POST", "/orders/{id}/cancel");
        },
        async executeCancel(orderId: string, signatures: string[]) {
          const r = await gateway.POST("/orders/{id}/cancel/execute", {
            headers,
            params: { path: { id: orderId } },
            body: { signatures, auth_type: "api_key" } as never,
          });
          if (!r.response.ok) throw new TmApiError(r.response.status, r.error, "POST", "/orders/{id}/cancel/execute");
          return r.data;
        },
      };
    },
  };
}

export type TmClient = ReturnType<typeof createTmClient>;
export type TmUserClient = ReturnType<TmClient["forUser"]>;
