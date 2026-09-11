/**
 * Equity and mark history. Samples come from the indexer (backfill + SSE) and
 * from the client's own polls; both merge into one tick-keyed store, so the
 * UI works with or without the indexer.
 */

export interface Sample {
  tick: number;
  t: number;
  /** Marks in USD, by market index. */
  marks: number[];
  /** Equity in USD by owner. */
  equities: Record<string, number>;
  alive?: Record<string, boolean>;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const n = (v: any): number => (typeof v === "number" ? v : typeof v === "string" ? Number(v) : v && typeof v.toString === "function" ? Number(v.toString()) : NaN);

/**
 * Indexer samples are `{t, tick, phase, marks[], equities[{owner, equity, alive, trades}]}`.
 * Values may be raw 6-dp integers (as on chain) or already in USD; the scale is
 * decided per sample from the marks (a raw mark is an integer >= 1e7, i.e. >= $10).
 */
export function normalizeIndexerSample(raw: any): Sample | null {
  if (!raw || typeof raw !== "object") return null;
  const tick = n(raw.tick);
  if (!Number.isFinite(tick)) return null;
  const marksRaw: number[] = Array.isArray(raw.marks) ? raw.marks.map(n) : [];
  const micro = raw.scale === "micro" || (raw.scale !== "usd" && marksRaw.some((m) => Number.isInteger(m) && Math.abs(m) >= 1e7));
  const k = micro ? 1e-6 : 1;
  const equities: Record<string, number> = {};
  const alive: Record<string, boolean> = {};
  const list: any[] = Array.isArray(raw.equities) ? raw.equities : [];
  for (const e of list) {
    if (!e || typeof e.owner !== "string") continue;
    const v = n(e.equity);
    if (Number.isFinite(v)) equities[e.owner] = v * k;
    if (e.alive !== undefined) alive[e.owner] = !!(typeof e.alive === "number" ? e.alive : e.alive === true || e.alive === "true" ? 1 : 0);
  }
  return { tick, t: Number.isFinite(n(raw.t)) ? n(raw.t) : Date.now(), marks: marksRaw.map((m) => m * k), equities, alive };
}

/** Accepts `[...]`, `{samples:[...]}`, or `{history:[...]}`. */
export function parseHistoryResponse(body: any): Sample[] {
  const arr: any[] = Array.isArray(body) ? body : Array.isArray(body?.samples) ? body.samples : Array.isArray(body?.history) ? body.history : [];
  return arr.map(normalizeIndexerSample).filter((s): s is Sample => !!s);
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export class HistoryStore {
  private byTick = new Map<number, Sample>();
  private sorted: Sample[] | null = null;
  constructor(readonly cap = 720) {}

  get size() {
    return this.byTick.size;
  }

  /** Merge a sample; later data for the same tick fills gaps without dropping owners. Returns true if anything changed. */
  add(s: Sample): boolean {
    const prev = this.byTick.get(s.tick);
    if (prev) {
      const before = Object.keys(prev.equities).length + prev.marks.length;
      prev.equities = { ...prev.equities, ...s.equities };
      if (s.marks.length > prev.marks.length) prev.marks = s.marks;
      if (s.alive) prev.alive = { ...(prev.alive ?? {}), ...s.alive };
      const changed = Object.keys(prev.equities).length + prev.marks.length !== before;
      if (changed) this.sorted = null;
      return changed;
    }
    this.byTick.set(s.tick, { ...s, equities: { ...s.equities } });
    this.sorted = null;
    if (this.byTick.size > this.cap) {
      const drop = [...this.byTick.keys()].sort((a, b) => a - b).slice(0, this.byTick.size - this.cap);
      for (const k of drop) this.byTick.delete(k);
    }
    return true;
  }

  samples(): Sample[] {
    if (!this.sorted) this.sorted = [...this.byTick.values()].sort((a, b) => a.tick - b.tick);
    return this.sorted;
  }

  /** Equity series for one owner (last `limit` samples that include it). */
  equity(owner: string, limit = 120): number[] {
    const out: number[] = [];
    for (const s of this.samples()) {
      const v = s.equities[owner];
      if (v !== undefined && Number.isFinite(v)) out.push(v);
    }
    return out.slice(-limit);
  }

  /** Aligned mark rows (every market present), oldest first. */
  markRows(nMarkets: number, limit = 720): number[][] {
    const rows: number[][] = [];
    for (const s of this.samples()) {
      if (s.marks.length >= nMarkets && s.marks.slice(0, nMarkets).every((m) => Number.isFinite(m) && m > 0)) rows.push(s.marks.slice(0, nMarkets));
    }
    return rows.slice(-limit);
  }

  clear() {
    this.byTick.clear();
    this.sorted = null;
  }
}
