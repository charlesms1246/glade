"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, errText } from "./http";

const FALLBACK_MS = 8000;
const REOPEN_MS = 30_000;

// One EventSource per tab, shared by every hook; the server caps streams per user.
const subs = new Set<() => void>();
let es: EventSource | null = null;
let connected = false;
let reopen: ReturnType<typeof setTimeout> | null = null;

function openStream() {
  if (es || typeof EventSource === "undefined") return;
  const s = new EventSource("/api/stream");
  es = s;
  const fire = () => subs.forEach((f) => f());
  s.addEventListener("intent", fire);
  s.addEventListener("floor", fire);
  s.onopen = () => (connected = true);
  s.onerror = () => {
    connected = false;
    // A refused connection (for example over the stream cap) is not retried by the browser; try again later.
    if (s.readyState === EventSource.CLOSED) {
      s.close();
      es = null;
      if (subs.size > 0) reopen = setTimeout(openStream, REOPEN_MS);
    }
  };
}

function subscribe(f: () => void) {
  subs.add(f);
  openStream();
  return () => {
    subs.delete(f);
    if (subs.size === 0) {
      if (reopen) clearTimeout(reopen);
      reopen = null;
      es?.close();
      es = null;
      connected = false;
    }
  };
}

/**
 * GET `path` now, when the shared stream reports an event for this user (unless `live` is false), and every `ms`
 * as a fallback. While the stream is down it polls every few seconds instead; a hidden tab does not poll.
 * `refresh` re-reads at once.
 */
export function usePoll<T>(path: string, ms = 60_000, live = true) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sent = useRef(0);
  const applied = useRef(0);
  const lastAt = useRef(0);
  const refresh = useCallback(async () => {
    const n = ++sent.current;
    lastAt.current = Date.now();
    try {
      const d = await api<T>(path);
      if (n < applied.current) return; // a newer response already landed
      applied.current = n;
      setData(d);
      setError(null);
    } catch (e) {
      if (n >= applied.current) setError(errText(e));
    }
  }, [path]);
  useEffect(() => {
    const first = setTimeout(refresh, 0);
    const tick = () => {
      if (document.hidden) return;
      const every = live && !connected ? FALLBACK_MS : ms;
      if (Date.now() - lastAt.current >= every) void refresh();
    };
    const t = setInterval(tick, FALLBACK_MS);
    document.addEventListener("visibilitychange", tick);
    const unsub = live ? subscribe(() => void refresh()) : () => {};
    return () => {
      clearTimeout(first);
      clearInterval(t);
      document.removeEventListener("visibilitychange", tick);
      unsub();
    };
  }, [refresh, ms, live]);
  return { data, error, refresh };
}
