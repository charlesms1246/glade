import type { LedgerEntry, PaperOrder, PaperRepo, PaperState } from "./types";

const clone = <T>(v: T): T => structuredClone(v);

/** In-memory PaperRepo for tests. update() is serialised per process, like a row lock. */
export function memoryPaperRepo(signers: Record<string, string> = {}) {
  const accounts = new Map<string, PaperState>();
  const orders = new Map<string, PaperOrder>();
  const ledger: (LedgerEntry & { userId: string })[] = [];
  let chain: Promise<unknown> = Promise.resolve();

  const repo: PaperRepo = {
    async signerPublicKey(userId) {
      return signers[userId] ?? null;
    },
    async load(userId) {
      const s = accounts.get(userId);
      return s ? clone(s) : null;
    },
    update(userId, fn) {
      const run = chain.then(async () => {
        const cur = accounts.get(userId);
        const res = await fn(cur ? clone(cur) : null, { getOrder: async (id) => repo.getOrder(id) });
        if (res === null) return null;
        accounts.set(userId, clone(res.state));
        for (const e of res.ledger) ledger.push({ ...e, userId });
        for (const o of res.orders ?? []) orders.set(o.id, clone(o));
        return res.result;
      });
      chain = run.catch(() => {});
      return run;
    },
    async insertOrder(order) {
      if (orders.has(order.id)) throw new Error("duplicate paper order id");
      orders.set(order.id, clone(order));
    },
    async getOrder(orderId) {
      const o = orders.get(orderId);
      return o ? clone(o) : null;
    },
  };
  return { repo, accounts, orders, ledger, signers };
}
