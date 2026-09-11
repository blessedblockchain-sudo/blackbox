"use client";
import { useCallback, useEffect, useState } from "react";
import type { BackStateResponse } from "../../lib/api-types";

export interface BackStateHandle {
  data: BackStateResponse | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
}

/** Polls GET /api/local/back (the local web backer: balances, licenses, jobs). */
export function useBackState(enabled: boolean, ms = 1500): BackStateHandle {
  const [data, setData] = useState<BackStateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!enabled) {
      setData(null);
      setLoading(false);
      return;
    }
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const res = await fetch("/api/local/back", { cache: "no-store" });
        const body = (await res.json()) as BackStateResponse | { error: string };
        if (!res.ok || "error" in body) throw new Error("error" in body ? body.error : `HTTP ${res.status}`);
        if (!stop) {
          setData(body);
          setError(null);
        }
      } catch (e) {
        if (!stop) setError(e instanceof Error ? e.message : String(e));
      }
      if (!stop) {
        setLoading(false);
        timer = setTimeout(load, document.hidden ? ms * 4 : ms);
      }
    };
    load();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [enabled, ms, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, refresh };
}
