/**
 * Server-only access to `.mb/round-<cluster>.json`. The file holds bot secret
 * keys; nothing leaves this module without passing through `sanitize`.
 */
import fs from "node:fs";
import path from "node:path";
import { ENDPOINTS } from "@blackbox/sdk/src/constants";
import type { Cluster, PublicBacker, PublicEntrant, PublicLicenseRecord, PublicRoundInfo } from "../api-types";

export interface RawEntrant {
  name?: string;
  owner: string;
  secretKey?: number[];
  bot?: boolean;
  [k: string]: unknown;
}

/** One entry of the round file's `licenses`: the runner settles each at round end. */
export interface RawLicenseRecord {
  name?: string;
  buyer: string;
  author: string;
  bot?: boolean;
  /** true: a crank task exists; false: the runner schedules it; absent: not decided yet. */
  scheduled?: boolean;
  source?: string;
  [k: string]: unknown;
}

export interface RawRoundFile {
  cluster?: string;
  roundId?: number;
  round?: string;
  mint?: string;
  feeds?: string[];
  markets?: string[];
  tickMs?: number;
  durationTicks?: number;
  mode?: string;
  phase?: string;
  registrationEndsAt?: number;
  startedAt?: number;
  updatedAt?: number;
  entrants?: RawEntrant[];
  external?: RawEntrant[];
  entrantOwners?: string[];
  backers?: RawEntrant[];
  licenses?: RawLicenseRecord[];
  [k: string]: unknown;
}

export function currentCluster(): Cluster {
  const c = process.env.NEXT_PUBLIC_CLUSTER ?? process.env.BLACKBOX_CLUSTER ?? "local";
  return c === "devnet" ? "devnet" : "local";
}

export function findRoundFile(cluster: Cluster, start = process.cwd()): string | null {
  const explicit = process.env.BLACKBOX_ROUND_FILE;
  if (explicit) return fs.existsSync(explicit) ? explicit : null;
  let dir = path.resolve(start);
  for (let i = 0; i < 6; i++) {
    const p = path.join(dir, ".mb", `round-${cluster}.json`);
    if (fs.existsSync(p)) return p;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

export function readRoundFile(cluster: Cluster = currentCluster()): RawRoundFile | null {
  const p = findRoundFile(cluster);
  if (!p) return null;
  try {
    return JSON.parse(fs.readFileSync(/*turbopackIgnore: true*/ p, "utf8")) as RawRoundFile;
  } catch {
    return null; // mid-write by the round runner; the caller retries on its next poll
  }
}

// ------------------------------------------------------------ writes

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Read-modify-write under the lock-file protocol shared with scripts/run-round.ts
 * and the MCP server: create `${file}.lock` with O_EXCL (a lock older than 5 s
 * is stale), write a temp file in the same directory, rename it over the file.
 */
export async function withRoundFileLock<T>(file: string, fn: () => T): Promise<T> {
  const lock = `${file}.lock`;
  const t0 = Date.now();
  for (;;) {
    try {
      fs.closeSync(fs.openSync(/*turbopackIgnore: true*/ lock, "wx"));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e;
      const age = Date.now() - (fs.statSync(/*turbopackIgnore: true*/ lock, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
      if (age > 5_000) fs.rmSync(/*turbopackIgnore: true*/ lock, { force: true });
      else if (Date.now() - t0 > 10_000) throw new Error(`round file lock ${lock} is busy`);
      else await sleep(25);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(/*turbopackIgnore: true*/ lock, { force: true });
  }
}

function writeJsonAtomic(file: string, value: unknown) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(/*turbopackIgnore: true*/ tmp, JSON.stringify(value, null, 2));
  fs.renameSync(/*turbopackIgnore: true*/ tmp, file);
}

/**
 * Add or update the license record for (buyer, author), keeping every other
 * field and record. Refuses when the file has moved on to another round.
 * Returns true when the record was added.
 */
export async function upsertLicenseRecord(file: string, round: string, rec: RawLicenseRecord): Promise<boolean> {
  return withRoundFileLock(file, () => {
    const cur = JSON.parse(fs.readFileSync(/*turbopackIgnore: true*/ file, "utf8")) as RawRoundFile;
    if (cur.round !== round) throw new Error(`round file now describes round ${cur.round ?? "(none)"}, not ${round}`);
    const list: RawLicenseRecord[] = Array.isArray(cur.licenses) ? cur.licenses : [];
    const i = list.findIndex((l) => l.buyer === rec.buyer && l.author === rec.author);
    if (i >= 0) list[i] = { ...list[i], ...rec };
    else list.push(rec);
    cur.licenses = list;
    writeJsonAtomic(file, cur);
    return i < 0;
  });
}

const SECRET_KEY = /^(secretKey|secret|privateKey|private_key|keypair|mnemonic|seedPhrase)$/i;

/** Deep copy without any secret-bearing field, at any depth. */
export function sanitize<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => sanitize(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY.test(k)) continue;
      out[k] = sanitize(v);
    }
    return out as T;
  }
  return value;
}

const hasKey = (e: RawEntrant) => Array.isArray(e.secretKey) && e.secretKey.length === 64;

export function publicEntrants(raw: RawRoundFile): PublicEntrant[] {
  const seen = new Set<string>();
  const out: PublicEntrant[] = [];
  const add = (e: RawEntrant, external: boolean) => {
    if (!e?.owner || seen.has(e.owner)) return;
    seen.add(e.owner);
    out.push({ name: String(e.name ?? ""), owner: e.owner, bot: !!e.bot, external, canActAs: hasKey(e) });
  };
  (raw.entrants ?? []).forEach((e) => add(e, false));
  (raw.external ?? []).forEach((e) => add(e, true));
  return out;
}

export function publicBackers(raw: RawRoundFile): PublicBacker[] {
  return (raw.backers ?? []).filter((b) => b && typeof b.owner === "string").map((b) => ({ name: String(b.name ?? ""), owner: b.owner }));
}

export function publicLicenses(raw: RawRoundFile): PublicLicenseRecord[] {
  return (raw.licenses ?? [])
    .filter((l) => l && typeof l.buyer === "string" && typeof l.author === "string")
    .map((l) => ({
      name: String(l.name ?? ""),
      buyer: l.buyer,
      author: l.author,
      bot: !!l.bot,
      scheduled: typeof l.scheduled === "boolean" ? l.scheduled : null,
      source: typeof l.source === "string" ? l.source : null,
    }));
}

/** Owner -> display name for everyone the round file names (entrants, agents, backers). */
export function namesFrom(raw: RawRoundFile | null): Map<string, { name: string; bot: boolean }> {
  const out = new Map<string, { name: string; bot: boolean }>();
  if (!raw) return out;
  for (const e of [...(raw.entrants ?? []), ...(raw.external ?? []), ...(raw.backers ?? [])]) {
    if (e?.owner && e.name) out.set(e.owner, { name: String(e.name), bot: !!e.bot });
  }
  return out;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function envRound(): Partial<RawRoundFile> | null {
  const v = process.env.NEXT_PUBLIC_ROUND;
  if (!v) return null;
  if (v.trim().startsWith("{")) {
    try {
      return JSON.parse(v) as RawRoundFile;
    } catch {
      return null;
    }
  }
  const id = Number(process.env.NEXT_PUBLIC_ROUND_ID);
  return { round: v.trim(), roundId: Number.isFinite(id) ? id : undefined };
}

export function publicRoundInfo(cluster: Cluster, localRoutes: boolean): PublicRoundInfo {
  const fromFile = readRoundFile(cluster);
  const raw: Partial<RawRoundFile> | null = fromFile ?? envRound();
  const source: PublicRoundInfo["source"] = fromFile ? "file" : raw ? "env" : "none";
  const r = sanitize(raw ?? {}) as RawRoundFile;
  const ep = ENDPOINTS[cluster];
  const mode = r.mode === "dark" ? "dark" : r.mode === "lit" ? "lit" : null;
  return {
    cluster,
    source,
    roundId: num(r.roundId),
    round: typeof r.round === "string" ? r.round : null,
    mint: typeof r.mint === "string" ? r.mint : null,
    feeds: Array.isArray(r.feeds) ? r.feeds.map(String) : [],
    markets: Array.isArray(r.markets) && r.markets.length ? r.markets.map(String) : ["SOL-PERP", "BTC-PERP", "ETH-PERP"],
    tickMs: num(r.tickMs),
    durationTicks: num(r.durationTicks),
    mode,
    phase: typeof r.phase === "string" ? r.phase : null,
    registrationEndsAt: num(r.registrationEndsAt),
    startedAt: num(r.startedAt),
    updatedAt: num(r.updatedAt),
    entrants: fromFile ? publicEntrants(fromFile) : [],
    entrantOwners: Array.isArray(r.entrantOwners) ? r.entrantOwners.map(String) : [],
    backers: fromFile ? publicBackers(r) : [],
    licenses: fromFile ? publicLicenses(r) : [],
    endpoints: {
      base: process.env.NEXT_PUBLIC_BASE_RPC ?? ep.base,
      tee: process.env.NEXT_PUBLIC_TEE_RPC ?? ep.tee,
    },
    indexerUrl: process.env.NEXT_PUBLIC_INDEXER_URL ?? "http://127.0.0.1:8787",
    localRoutes: localRoutes && !!fromFile && cluster === "local",
  };
}
