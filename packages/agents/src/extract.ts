/**
 * Tolerant readers for MCP structured results. The runner and the scripted
 * agent only need a few fields (tick, joined/funded flags, equity, margin,
 * strategy version); these helpers find them without hard-coding one shape.
 */
import type { ToolOutcome } from "./types";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Number from a number, numeric string, or bigint-like; USDC strings like "190.5 USDC" also parse. */
export function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") {
    const m = /^\s*\$?(-?\d+(?:\.\d+)?)/.exec(v);
    if (m) return Number(m[1]);
  }
  return undefined;
}

/**
 * Breadth-first search for the first key in `keys` (in priority order at each
 * depth) whose value satisfies `accept`. Arrays are not descended into, so
 * per-entrant lists (scoreboards) never leak into "my" fields.
 */
export function deepFind<T>(root: unknown, keys: string[], accept: (v: unknown) => T | undefined, maxDepth = 4, prefer: string[] = []): T | undefined {
  let level: Record<string, unknown>[] = isObj(root) ? [root] : [];
  for (let d = 0; d <= maxDepth && level.length; d++) {
    for (const o of level) {
      for (const k of keys) {
        if (k in o) {
          const got = accept(o[k]);
          if (got !== undefined) return got;
        }
      }
    }
    const next: Record<string, unknown>[] = [];
    for (const o of level) {
      const entries = Object.entries(o).filter(([, v]) => isObj(v));
      entries.sort(([a], [b]) => (prefer.includes(b) ? 1 : 0) - (prefer.includes(a) ? 1 : 0));
      for (const [, v] of entries) next.push(v as Record<string, unknown>);
    }
    level = next;
  }
  return undefined;
}

const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : v === 1 || v === "yes" || v === "true" ? true : v === 0 || v === "no" || v === "false" ? false : undefined);

const CALLER_KEYS = ["caller", "you", "me", "self", "agent", "entrant", "status", "my"];

export interface CallerStatus {
  joined?: boolean;
  funded?: boolean;
  alive?: boolean;
  owner?: string;
}

/** The caller's status block from get_round. */
export function callerStatus(r: ToolOutcome | undefined): CallerStatus {
  if (!r || r.isError) return {};
  const s = r.structured;
  const out: CallerStatus = {
    joined: deepFind(s, ["joined", "isEntrant", "registered"], bool, 3, CALLER_KEYS),
    funded: deepFind(s, ["funded", "entered"], bool, 3, CALLER_KEYS),
    alive: deepFind(s, ["alive"], bool, 3, CALLER_KEYS),
    owner: deepFind(s, ["owner", "pubkey", "wallet", "address"], (v) => (typeof v === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v) ? v : undefined), 3, CALLER_KEYS),
  };
  if (out.joined === undefined) {
    const m = /\bjoined\W{0,3}\s*(true|yes|false|no)\b/i.exec(r.text);
    if (m) out.joined = /true|yes/i.test(m[1]);
    else if (/\bnot (yet )?(joined|registered|an entrant)\b/i.test(r.text)) out.joined = false;
  }
  if (out.funded === undefined) {
    const m = /\bfunded\W{0,3}\s*(true|yes|false|no)\b/i.exec(r.text);
    if (m) out.funded = /true|yes/i.test(m[1]);
  }
  return out;
}

export function roundTick(r: ToolOutcome | undefined): { tick?: number; duration?: number } {
  if (!r || r.isError) return {};
  const tick = deepFind(r.structured, ["tick", "currentTick"], num, 2, ["round"]);
  const duration = deepFind(r.structured, ["durationTicks", "duration", "duration_ticks"], num, 2, ["round"]);
  if (tick !== undefined) return { tick, duration };
  const m = /\btick\D{0,3}(\d+)(?:\s*(?:\/|of)\s*(\d+))?/i.exec(r.text);
  return m ? { tick: Number(m[1]), duration: m[2] ? Number(m[2]) : undefined } : {};
}

export interface PositionView {
  equity?: number;
  margin?: number;
  realizedPnl?: number;
  unrealizedPnl?: number;
  liquidated?: boolean;
}

/** Equity and margin from read_my_position (same units as the server reports; only ratios are used). */
export function positionView(r: ToolOutcome | undefined): PositionView {
  if (!r || r.isError) return {};
  const s = r.structured;
  const v: PositionView = {
    equity: deepFind(s, ["equity", "equityUsdc", "equity_usdc", "equityEstimate", "estimatedEquity", "equity_estimate"], num, 3, ["position", "account"]),
    margin: deepFind(s, ["margin", "marginUsdc", "margin_usdc", "deposited", "initialMargin"], num, 3, ["position", "account"]),
    realizedPnl: deepFind(s, ["realizedPnl", "realized_pnl", "realizedPnlUsdc"], num, 3, ["position"]),
    unrealizedPnl: deepFind(s, ["unrealizedPnl", "unrealized_pnl", "upnl", "unrealizedPnlUsdc"], num, 3, ["position"]),
    liquidated: deepFind(s, ["liquidated"], bool, 3, ["position"]),
  };
  if (v.equity === undefined) {
    const m = /\bequity\D{0,12}?(-?\d+(?:\.\d+)?)/i.exec(r.text);
    if (m) v.equity = Number(m[1]);
  }
  if (v.margin === undefined) {
    const m = /\bmargin\D{0,12}?(-?\d+(?:\.\d+)?)/i.exec(r.text);
    if (m) v.margin = Number(m[1]);
  }
  return v;
}

/** Strategy version reported by enter_round / hot_swap_strategy. */
export function strategyVersion(r: ToolOutcome | undefined): number | undefined {
  if (!r || r.isError) return undefined;
  const v = deepFind(r.structured, ["version", "strategyVersion", "newVersion"], num, 3);
  if (v !== undefined) return v;
  const m = /\bversion\D{0,3}(\d+)/i.exec(r.text);
  return m ? Number(m[1]) : undefined;
}

/** Whether the scripted agent's position is losing: equity below the starting margin. */
export function isLosing(p: PositionView, startingEquity: number | null): boolean {
  const base = p.margin ?? startingEquity ?? undefined;
  if (p.equity === undefined || base === undefined || base <= 0) {
    if (p.realizedPnl !== undefined || p.unrealizedPnl !== undefined) return (p.realizedPnl ?? 0) + (p.unrealizedPnl ?? 0) < 0;
    return false;
  }
  return p.equity < base;
}
