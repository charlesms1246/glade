"use client";

import { useCallback, useEffect, useState } from "react";
import { api, errText } from "./http";

/** GET `path` now, every `ms`, and whenever the server streams an event for this user; `refresh` re-reads at once. */
export function usePoll<T>(path: string, ms = 8000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      setData(await api<T>(path));
      setError(null);
    } catch (e) {
      setError(errText(e));
    }
  }, [path]);
  useEffect(() => {
    const first = setTimeout(refresh, 0);
    const t = setInterval(refresh, ms);
    const es = new EventSource("/api/stream");
    const onEvent = () => void refresh();
    es.addEventListener("intent", onEvent);
    es.addEventListener("floor", onEvent);
    return () => {
      clearTimeout(first);
      clearInterval(t);
      es.close();
    };
  }, [refresh, ms]);
  return { data, error, refresh };
}
