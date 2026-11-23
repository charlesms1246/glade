import type { ExecutorRepo, OrderRow } from "./types";

/** In-memory repo with the same uniqueness rule as the database. */
export function memoryRepo() {
  const orders = new Map<string, OrderRow>();
  const intents = new Map<string, string>();
  const k = (i: string, a: number) => `${i}#${a}`;
  const repo: ExecutorRepo = {
    async listOrders(intentId) {
      return [...orders.values()].filter((o) => o.intentId === intentId).map((o) => ({ ...o }));
    },
    async insertOrder(row) {
      if (orders.has(k(row.intentId, row.attempt))) throw new Error("duplicate (intent_id, attempt)");
      orders.set(k(row.intentId, row.attempt), { ...row });
    },
    async updateOrder(intentId, attempt, patch) {
      const cur = orders.get(k(intentId, attempt));
      if (!cur) throw new Error("order not found");
      orders.set(k(intentId, attempt), { ...cur, ...patch });
    },
    async setIntentStatus(intentId, status) {
      intents.set(intentId, status);
    },
  };
  return { repo, orders, intents };
}
