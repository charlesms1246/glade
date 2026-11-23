import { gladeEvents, type GladeEvent } from "@/lib/server/events";
import { sessionUserId } from "@/lib/server/session";

const HEARTBEAT_MS = 25_000;

/** Server-sent events: Bell updates for everyone, intent results only for the signed-in user. */
export async function GET(req: Request) {
  const uid = await sessionUserId();
  const events = gladeEvents();
  const enc = new TextEncoder();
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
        if (e.type === "bell" || (e.type === "intent" && uid && e.data?.userId === uid)) {
          write(`event: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`);
        }
      };
      events.on("event", onEvent);
      const hb = setInterval(() => write(": heartbeat\n\n"), HEARTBEAT_MS);
      stop = () => {
        events.off("event", onEvent);
        clearInterval(hb);
      };
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
