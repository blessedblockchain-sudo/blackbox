"use client";
/**
 * Live data hooks. The browser polls the TEE's public endpoint directly (no
 * token: it returns public accounts only) and decodes with the Anchor coder.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Connection, PublicKey } from "@solana/web3.js";
import type { PublicRoundInfo } from "./api-types";
import {
  chatPda,
  decodeAccount,
  decodeChat,
  type ChatMessage,
  entrantPda,
  marketPda,
  scoreboardPda,
  toEntrantView,
  toMarketView,
  toRoundView,
  toScoreboardView,
  type EntrantView,
  type MarketView,
  type RoundView,
  type ScoreboardView,
} from "./chain";
import { HistoryStore, parseHistoryResponse, normalizeIndexerSample, type Sample } from "./history";

// ------------------------------------------------------------------ round info

export function useRoundInfo(refreshMs = 5000) {
  const [info, setInfo] = useState<PublicRoundInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const res = await fetch("/api/round", { cache: "no-store" });
        if (!res.ok) throw new Error(`/api/round ${res.status}`);
        const next = (await res.json()) as PublicRoundInfo;
        if (!stop) {
          // keep identity stable when nothing changed, so effects keyed on it do not restart
          setInfo((prev) => (prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
          setError(null);
        }
      } catch (e) {
        if (!stop) setError(e instanceof Error ? e.message : String(e));
      }
      if (!stop) timer = setTimeout(load, refreshMs);
    };
    load();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [refreshMs]);
  return { info, error };
}

// ------------------------------------------------------------------ live accounts

export interface LiveState {
  round: RoundView | null;
  scoreboard: ScoreboardView | null;
  /** Public read of the scoreboard returned null (dark round). */
  scoreboardSealed: boolean;
  markets: (MarketView | null)[];
  entrants: Record<string, EntrantView>;
  status: "idle" | "loading" | "live" | "stale" | "error" | "missing";
  error: string | null;
  lastOk: number | null;
  latencyMs: number | null;
}

const EMPTY: LiveState = {
  round: null,
  scoreboard: null,
  scoreboardSealed: false,
  markets: [],
  entrants: {},
  status: "idle",
  error: null,
  lastOk: null,
  latencyMs: null,
};

export function useLiveRound(info: PublicRoundInfo | null, pollMs = 700): LiveState {
  const [state, setState] = useState<LiveState>(EMPTY);
  const roundKey = info?.round ?? null;
  const tee = info?.endpoints.tee ?? null;
  const nMarkets = info?.markets.length ?? 0;
  const ownersKey = [...new Set([...(info?.entrantOwners ?? []), ...(info?.entrants ?? []).map((e) => e.owner)])].join(",");
  const hasInfo = !!info;
  const lastRound = useRef<string | null>(null);

  useEffect(() => {
    if (!roundKey || !tee) {
      setState({ ...EMPTY, status: hasInfo ? "missing" : "idle" });
      return;
    }
    // Reset only when the round itself changes; owner-list changes keep the last frame.
    if (lastRound.current !== roundKey) setState({ ...EMPTY, status: "loading" });
    lastRound.current = roundKey;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let etimer: ReturnType<typeof setTimeout> | undefined;
    const conn = new Connection(tee, { commitment: "processed" });
    const round = new PublicKey(roundKey);
    const keys = [round, scoreboardPda(round), ...Array.from({ length: nMarkets }, (_, i) => marketPda(round, i))];
    const knownOwners = new Set(ownersKey ? ownersKey.split(",") : []);

    const poll = async () => {
      const t0 = performance.now();
      try {
        const infos = await conn.getMultipleAccountsInfo(keys, "processed");
        const ms = Math.round(performance.now() - t0);
        if (stop) return;
        const [ri, si, ...mi] = infos;
        const r = ri ? toRoundView(decodeAccount("round", ri.data)) : null;
        const sb = si ? toScoreboardView(decodeAccount("scoreboard", si.data)) : null;
        sb?.entries.forEach((e) => knownOwners.add(e.owner));
        const markets = mi.map((m) => (m ? toMarketView(decodeAccount("market", m.data)) : null));
        setState((prev) => ({
          ...prev,
          round: r,
          scoreboard: sb,
          scoreboardSealed: !!r && !sb,
          markets,
          status: r ? "live" : "missing",
          error: r ? null : "round account not visible on the TEE",
          lastOk: Date.now(),
          latencyMs: ms,
        }));
      } catch (e) {
        if (!stop)
          setState((prev) => ({
            ...prev,
            status: prev.lastOk && Date.now() - prev.lastOk < 5000 ? "stale" : "error",
            error: e instanceof Error ? e.message : String(e),
          }));
      }
      if (!stop) timer = setTimeout(poll, document.hidden ? pollMs * 4 : pollMs);
    };

    // Entrant accounts are public (version, alive, deposit); they change rarely.
    const pollEntrants = async () => {
      const owners = [...knownOwners];
      if (owners.length) {
        try {
          const infos = await conn.getMultipleAccountsInfo(owners.map((o) => entrantPda(round, new PublicKey(o))), "processed");
          if (stop) return;
          const entrants: Record<string, EntrantView> = {};
          infos.forEach((acc, i) => {
            if (acc) entrants[owners[i]] = toEntrantView(decodeAccount("entrant", acc.data));
          });
          setState((prev) => ({ ...prev, entrants }));
        } catch {
          /* keep the last good entrant set */
        }
      }
      if (!stop) etimer = setTimeout(pollEntrants, owners.length ? 4000 : 1000);
    };

    poll();
    pollEntrants();
    return () => {
      stop = true;
      clearTimeout(timer);
      clearTimeout(etimer);
    };
  }, [roundKey, tee, nMarkets, ownersKey, pollMs, hasInfo]);

  // Downgrade to "stale" when polls stop succeeding.
  useEffect(() => {
    const id = setInterval(() => {
      setState((prev) => (prev.status === "live" && prev.lastOk && Date.now() - prev.lastOk > 3000 ? { ...prev, status: "stale" } : prev));
    }, 1000);
    return () => clearInterval(id);
  }, []);

  return state;
}

// ------------------------------------------------------------------ history

export interface HistoryHandle {
  store: HistoryStore;
  version: number;
  source: "indexer" | "client";
  samples: number;
}

/** Equity/mark history: indexer backfill + SSE when available, client samples always. */
export function useHistory(info: PublicRoundInfo | null, live: LiveState): HistoryHandle {
  const storeRef = useRef(new HistoryStore(720));
  const [version, setVersion] = useState(0);
  const [indexerUp, setIndexerUp] = useState(false);
  const roundKey = info?.round ?? null;
  const indexer = info?.indexerUrl ?? null;
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    storeRef.current.clear();
    bump();
    if (!roundKey || !indexer) return;
    let stop = false;
    let es: EventSource | null = null;
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 2500);
    fetch(`${indexer}/rounds/${roundKey}/history`, { signal: ctrl.signal, cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((body) => {
        if (stop) return;
        const samples = parseHistoryResponse(body);
        samples.forEach((s) => storeRef.current.add(s));
        if (samples.length) bump();
        try {
          es = new EventSource(`${indexer}/rounds/${roundKey}/stream`);
          es.onopen = () => setIndexerUp(true);
          es.onerror = () => setIndexerUp(false);
          const onSample = (ev: MessageEvent<string>) => {
            try {
              const s = normalizeIndexerSample(JSON.parse(ev.data));
              if (s && storeRef.current.add(s)) bump();
            } catch {
              /* ignore malformed frames */
            }
          };
          // The indexer names its events "sample"; accept unnamed frames too.
          es.addEventListener("sample", onSample as EventListener);
          es.onmessage = onSample;
        } catch {
          setIndexerUp(false);
        }
      })
      .catch(() => setIndexerUp(false))
      .finally(() => clearTimeout(timeout));
    return () => {
      stop = true;
      ctrl.abort();
      es?.close();
      setIndexerUp(false);
    };
  }, [roundKey, indexer, bump]);

  // Client-side samples from the live poll (one per observed tick).
  const tick = live.round?.tick ?? null;
  useEffect(() => {
    if (tick === null || !live.round) return;
    const s: Sample = {
      tick,
      t: Date.now(),
      marks: live.markets.map((m) => (m ? m.mark : NaN)),
      equities: {},
      alive: {},
    };
    live.scoreboard?.entries.forEach((e) => {
      s.equities[e.owner] = e.equity;
      s.alive![e.owner] = e.alive;
    });
    if (storeRef.current.add(s)) bump();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);

  return { store: storeRef.current, version, source: indexerUp ? "indexer" : "client", samples: storeRef.current.size };
}

// ------------------------------------------------------------------ round chat

export interface ChatState {
  messages: ChatMessage[];
  /** The ephemeral chat account exists (someone has posted this round). */
  exists: boolean;
  error: string | null;
}

const sameChat = (a: ChatMessage[], b: ChatMessage[]) => {
  if (a.length !== b.length) return false;
  const x = a[a.length - 1];
  const y = b[b.length - 1];
  return !x || (x.author === y.author && x.tick === y.tick && x.ts === y.ts && x.text === y.text);
};

/** The public round chat, read from the TEE without a token (it is a public ephemeral account). */
export function useChat(info: PublicRoundInfo | null, pollMs = 1500): ChatState {
  const [state, setState] = useState<ChatState>({ messages: [], exists: false, error: null });
  const roundKey = info?.round ?? null;
  const tee = info?.endpoints.tee ?? null;
  useEffect(() => {
    setState({ messages: [], exists: false, error: null });
    if (!roundKey || !tee) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const conn = new Connection(tee, { commitment: "processed" });
    const key = chatPda(new PublicKey(roundKey));
    const poll = async () => {
      try {
        const acc = await conn.getAccountInfo(key, "processed");
        if (stop) return;
        const messages = acc ? decodeChat(acc.data) : [];
        setState((prev) => (prev.exists === !!acc && !prev.error && sameChat(prev.messages, messages) ? prev : { messages, exists: !!acc, error: null }));
      } catch (e) {
        if (!stop) setState((prev) => ({ ...prev, error: e instanceof Error ? e.message : String(e) }));
      }
      if (!stop) timer = setTimeout(poll, document.hidden ? pollMs * 4 : pollMs);
    };
    poll();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [roundKey, tee, pollMs]);
  return state;
}

// ------------------------------------------------------------------ misc

const reducedQuery = "(prefers-reduced-motion: reduce)";
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia(reducedQuery);
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    () => window.matchMedia(reducedQuery).matches,
    () => false,
  );
}

/** Current wall clock, re-rendering every `ms`. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}
