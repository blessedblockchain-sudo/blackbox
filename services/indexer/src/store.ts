/**
 * Per-round in-memory time series backed by an append-only JSONL file at
 * .mb/indexer/<round>.jsonl. One store per round; samples are appended only
 * when the tick advances.
 */
import * as fs from "fs";
import * as path from "path";
import { RoundInfo, Sample } from "./types";

const ROOT = path.resolve(__dirname, "../../..");
export const INDEXER_DIR = path.join(ROOT, ".mb/indexer");

type Listener = (s: Sample) => void;

export class RoundStore {
  readonly round: string;
  readonly file: string;
  private samples: Sample[] = [];
  private byTick = new Set<number>();
  private listeners = new Set<Listener>();
  info: RoundInfo | null = null;
  lastTick = -1;

  constructor(round: string) {
    this.round = round;
    this.file = path.join(INDEXER_DIR, `${round}.jsonl`);
    this.backfill();
  }

  /** Load any samples persisted from an earlier run so history survives restarts. */
  private backfill() {
    if (!fs.existsSync(this.file)) return;
    const text = fs.readFileSync(this.file, "utf8");
    for (const line of text.split("\n")) {
      const l = line.trim();
      if (!l) continue;
      try {
        const s = JSON.parse(l) as Sample;
        if (!this.byTick.has(s.tick)) {
          this.samples.push(s);
          this.byTick.add(s.tick);
          if (s.tick > this.lastTick) this.lastTick = s.tick;
        }
      } catch {
        /* skip malformed line */
      }
    }
  }

  /** Append a sample if its tick is new. Returns true when stored. */
  append(s: Sample): boolean {
    if (this.byTick.has(s.tick)) return false;
    this.samples.push(s);
    this.byTick.add(s.tick);
    if (s.tick > this.lastTick) this.lastTick = s.tick;
    fs.mkdirSync(INDEXER_DIR, { recursive: true });
    fs.appendFileSync(this.file, JSON.stringify(s) + "\n");
    for (const fn of this.listeners) {
      try { fn(s); } catch { /* listener errors must not stop indexing */ }
    }
    return true;
  }

  /** Samples with tick strictly greater than `since` (default: all). */
  history(since = -1): Sample[] {
    return since < 0 ? this.samples.slice() : this.samples.filter((s) => s.tick > since);
  }

  latest(): Sample | null {
    return this.samples.length ? this.samples[this.samples.length - 1] : null;
  }

  count(): number {
    return this.samples.length;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

/** Registry of round stores, one per round PDA the indexer has seen. */
export class StoreRegistry {
  private stores = new Map<string, RoundStore>();

  get(round: string): RoundStore {
    let s = this.stores.get(round);
    if (!s) {
      s = new RoundStore(round);
      this.stores.set(round, s);
    }
    return s;
  }

  peek(round: string): RoundStore | undefined {
    return this.stores.get(round);
  }

  rounds(): string[] {
    return [...this.stores.keys()];
  }
}
