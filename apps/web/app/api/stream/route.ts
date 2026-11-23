import { fail } from "@/lib/server/api";
import { gladeEvents, type GladeEvent } from "@/lib/server/events";
import { sessionToken, userIdFromToken } from "@/lib/server/session";

const HEARTBEAT_MS = 25_000;
const MAX_STREAMS_PER_USER = 3;

const g = globalThis as unknown as { __gladeStreams?: Map<string, number> };
const open = (g.__gladeStreams ??= new Map());

/** Server-sent events for the signed-in user: their intent and Floor results, and Bell updates. */
export async function GET(req: Request) {
  const token = await sessionToken();
  const uid = userIdFromToken(token);
  if (!uid) return fail(401, "Sign in first.");
  if ((open.get(uid) ?? 0) >= MAX_STREAMS_PER_USER) return fail(429, "Too many live connections. Close another tab.");
  open.set(uid, (open.get(uid) ?? 0) + 1);

  const events = gladeEvents();
  const enc = new TextEncoder();
  let stopped = false;
  let stop = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      const write = (s: string) => {
        try {
          ctrl.enqueue(enc.encode(s));
        } catch {
          stop();
        }
      };
      const onEvent = (e: GladeEvent) => {
        if (e.type === "bell" || ((e.type === "intent" || e.type === "floor") && e.data?.userId === uid)) {
          write(`event: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`);
        }
      };
      const hb = setInterval(() => {
        // The session can expire while the stream is open; end it then.
        if (userIdFromToken(token) !== uid) {
          stop();
          try {
            ctrl.close();
          } catch {}
          return;
        }
        write(": heartbeat\n\n");
      }, HEARTBEAT_MS);
      stop = () => {
        if (stopped) return;
        stopped = true;
        events.off("event", onEvent);
        clearInterval(hb);
        const n = (open.get(uid) ?? 1) - 1;
        if (n > 0) open.set(uid, n);
        else open.delete(uid);
      };
      events.on("event", onEvent);
      req.signal.addEventListener("abort", () => {
        stop();
        try {
          ctrl.close();
        } catch {}
      });
      write("retry: 5000\n: connected\n\n");
    },
    cancel() {
      stop();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
