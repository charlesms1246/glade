import "server-only";
import { EventEmitter } from "node:events";
import postgres from "postgres";

export type GladeEvent =
  | { type: "intent"; data: { userId: string; intentId: string; outcome: string; explanation: string } }
  | { type: "bell"; data: unknown };

const g = globalThis as unknown as { __gladeEvents?: EventEmitter };

/** Process-wide fan-out of the worker's `glade_events` notifications, on one dedicated LISTEN connection. */
export function gladeEvents(): EventEmitter {
  if (!g.__gladeEvents) {
    const emitter = new EventEmitter();
    emitter.setMaxListeners(0);
    g.__gladeEvents = emitter;
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    const sql = postgres(url, { max: 1, prepare: false });
    sql
      .listen("glade_events", (payload) => {
        try {
          emitter.emit("event", JSON.parse(payload) as GladeEvent);
        } catch {
          // Ignore malformed payloads.
        }
      })
      .catch((e) => {
        console.error("glade_events listen failed", e);
        g.__gladeEvents = undefined;
      });
  }
  return g.__gladeEvents;
}
