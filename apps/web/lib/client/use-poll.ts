"use client";

import { useCallback, useEffect, useState } from "react";
import { api, errText } from "./http";

/** GET `path` now and every `ms`; `refresh` re-reads at once. */
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
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [refresh, ms]);
  return { data, error, refresh };
}
