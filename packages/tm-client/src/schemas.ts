import { z } from "zod";

// Boundary validation for the responses Glade acts on. Unknown fields pass through.
const decStr = z.string().regex(/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/);
const optDec = decStr.nullish();

export const orderStatus = z.enum([
  "initialized",
  "pending",
  "cancel_pending",
  "complete",
  "canceled",
  "active",
  "failed",
]);
export type OrderStatus = z.infer<typeof orderStatus>;

export const unsignedPayload = z.object({ digest: z.string(), payload: z.string() });

export const createOrderResponse = z
  .object({
    order_id: z.string().optional(),
    status: orderStatus.optional(),
    payloads: z.array(unsignedPayload).optional(),
    quote: z
      .object({ qty: optDec, qty_out: optDec, fee: optDec, fee_asset: z.string().optional(), issues: z.array(z.string()).optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type CreateOrderResponse = z.infer<typeof createOrderResponse>;

export const orderDetail = z
  .object({
    order_id: z.string().optional(),
    asset_id: z.string().nullish(),
    side: z.enum(["buy", "sell"]).optional(),
    status: orderStatus.optional(),
    qty: optDec,
    executed_qty: optDec,
    executed_vwap: optDec,
    fee: optDec,
    explorer_url: z.string().optional(),
    failure_reason: z.string().optional(),
    asset_type: z.enum(["spot", "perp"]).optional(),
  })
  .passthrough();
export type OrderDetail = z.infer<typeof orderDetail>;

export const position = z
  .object({
    asset_id: z.string().optional(),
    symbol: z.string().optional(),
    side: z.enum(["long", "short"]).optional(),
    size: optDec,
    entry_price: optDec,
    mark_price: optDec,
    liquidation_price: optDec,
    margin_used: optDec,
    unrealized_pnl: optDec,
    leverage: z.number().optional(),
  })
  .passthrough();
export type Position = z.infer<typeof position>;
export const positionsResponse = z.object({ positions: z.array(position) }).passthrough();

export const portfolioBalance = z
  .object({
    asset_id: z.string().optional(),
    economic_asset_id: z.string().optional(),
    symbol: z.string(),
    venue: z.string(),
    chain: z.string().nullish(),
    stable: z.boolean(),
    tradeable: z.boolean(),
    total: decStr,
    available: decStr,
    price: optDec,
    value: optDec,
  })
  .passthrough();
export type PortfolioBalance = z.infer<typeof portfolioBalance>;

export const portfolioResponse = z
  .object({
    total_usd: optDec,
    cash_usd: optDec,
    balances: z.array(portfolioBalance),
    positions: z.array(position),
  })
  .passthrough();
export type Portfolio = z.infer<typeof portfolioResponse>;

export const assetItem = z
  .object({
    id: z.string().optional(),
    economic_asset_id: z.string().optional(),
    chain: z.string().nullish(),
    symbol: z.string().optional(),
    name: z.string().optional(),
    venue: z.string().optional(),
    type: z.enum(["spot", "perp"]).optional(),
    asset_class: z.enum(["crypto", "stock"]).optional(),
    tradeable: z.boolean().optional(),
    perp: z
      .object({ funding_rate: optDec, open_interest: optDec, max_leverage: z.number().nullish() })
      .passthrough()
      .nullish(),
    order_types: z.array(z.string()),
  })
  .passthrough();
export type AssetItem = z.infer<typeof assetItem>;
export const listAssetsResponse = z
  .object({
    data: z.array(assetItem).optional(),
    pagination: z.object({ next_cursor: z.string().nullish() }).passthrough().optional(),
  })
  .passthrough();

export const createUserResponse = z
  .object({
    user_id: z.string(),
    wallets: z.array(z.object({ chain_family: z.string(), address: z.string() }).passthrough()),
  })
  .passthrough();
export type CreateUserResponse = z.infer<typeof createUserResponse>;

export const priceResponse = z
  .object({
    asset_id: z.string().optional(),
    symbol: z.string().optional(),
    candles: z
      .array(z.object({ interval: z.string().optional(), closePrice: optDec, openPrice: optDec }).passthrough())
      .optional(),
  })
  .passthrough();

export const historyResponse = z
  .object({
    symbol: z.string().optional(),
    resolution: z.string().optional(),
    points: z.array(z.object({ t: z.string(), price: decStr }).passthrough()).optional(),
  })
  .passthrough();
export type PricePoint = { t: string; price: string };

export const perpHistoryResponse = z
  .object({
    symbol: z.string().optional(),
    points: z
      .array(z.object({ t: z.string(), funding_rate: optDec, open_interest: optDec }).passthrough())
      .optional(),
  })
  .passthrough();

export const availabilityResponse = z
  .object({
    country: z.string(),
    allowed_product_types: z.array(z.string()),
    allowed_asset_classes: z.array(z.string()),
  })
  .passthrough();
export type Availability = z.infer<typeof availabilityResponse>;
