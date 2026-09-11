/**
 * The round state file written by scripts/run-round.ts (.mb/round-<cluster>.json).
 * The MCP server reads it for addresses and phase, and appends external
 * entrants (agents) to its `external` array.
 */
import * as fs from "fs";
import * as path from "path";

export type Phase = "registration" | "delegating" | "live" | "settling" | "settled";

export interface RoundEntrantRecord {
  name: string;
  owner: string;
  bot: boolean;
  /** Present for runner-owned bots only. Never returned by any tool. */
  secretKey?: number[];
}

/** A blind license opened in this round. The runner settles every listed license at round end. */
export interface LicenseRecord {
  name?: string;
  buyer: string;
  author: string;
  bot?: boolean;
  /** false: no crank task yet, the runner schedules it. Absent or true: already scheduled. */
  scheduled?: boolean;
}

export interface RoundFile {
  cluster: string;
  roundId: number;
  round: string;
  mint: string;
  feeds: string[];
  markets: string[];
  tickMs: number;
  durationTicks: number;
  mode: "lit" | "dark";
  phase: Phase;
  registrationEndsAt?: number;
  startedAt?: number;
  updatedAt?: number;
  entrants?: RoundEntrantRecord[];
  external?: RoundEntrantRecord[];
  entrantOwners?: string[];
  backers?: RoundEntrantRecord[];
  licenses?: LicenseRecord[];
}

export function readRoundFile(file: string): RoundFile {
  if (!fs.existsSync(file)) {
    throw new Error(`No round state file at ${file}. Start a round with scripts/run-round.ts or set BLACKBOX_ROUND_FILE.`);
  }
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const k of ["round", "mint", "markets", "feeds"]) {
    if (raw[k] === undefined) throw new Error(`Round file ${file} is missing "${k}"`);
  }
  return raw as RoundFile;
}

/** Market symbol for the compiler: "SOL-PERP" -> "SOL". */
export function marketSymbol(name: string): string {
  return name.replace(/-PERP$/i, "").toUpperCase();
}

/**
 * Resolve a user-supplied market reference ("SOL", "sol-perp", "0") to an index.
 * Throws with the list of valid markets when it does not match.
 */
export function resolveMarket(markets: string[], ref: string | number): number {
  if (typeof ref === "number" || /^\d+$/.test(String(ref).trim())) {
    const i = Number(ref);
    if (i >= 0 && i < markets.length) return i;
  } else {
    const want = marketSymbol(String(ref).trim());
    const i = markets.findIndex((m) => marketSymbol(m) === want);
    if (i >= 0) return i;
  }
  throw new Error(`Unknown market "${ref}". Markets in this round: ${markets.map((m, i) => `${i}=${m}`).join(", ")}`);
}

/** Owner base58 -> display name for every entrant listed in the file. */
export function entrantNames(rf: RoundFile): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of [...(rf.entrants ?? []), ...(rf.external ?? [])]) out.set(e.owner, e.name);
  return out;
}

/** Cross-process lock around read-modify-write of the round file (agents run one server each). */
function withFileLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`;
  const t0 = Date.now();
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lock, "wx"));
      break;
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
      const age = Date.now() - (fs.statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
      if (age > 5_000) fs.rmSync(lock, { force: true });
      else if (Date.now() - t0 > 10_000) throw new Error(`round file lock ${lock} is busy`);
      else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

/** True when the owner is already listed (bot or external). */
export function isRecorded(file: string, owner: string): boolean {
  const cur = JSON.parse(fs.readFileSync(file, "utf8"));
  return [...(cur.entrants ?? []), ...(cur.external ?? [])].some((e: RoundEntrantRecord) => e.owner === owner);
}

/**
 * Read-modify-write append of an external entrant, idempotent by owner.
 * Serialized with a lock file across MCP server processes, and written through
 * a temp file + rename so readers never see a torn file. Returns true when the
 * record was added.
 */
export function appendExternal(file: string, rec: { name: string; owner: string }): boolean {
  return withFileLock(file, () => {
    const cur = JSON.parse(fs.readFileSync(file, "utf8"));
    const ext: RoundEntrantRecord[] = Array.isArray(cur.external) ? cur.external : [];
    const bots: RoundEntrantRecord[] = Array.isArray(cur.entrants) ? cur.entrants : [];
    if (ext.some((e) => e.owner === rec.owner) || bots.some((e) => e.owner === rec.owner)) return false;
    cur.external = [...ext, { name: rec.name, owner: rec.owner, bot: false }];
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(cur, null, 2));
    fs.renameSync(tmp, file);
    return true;
  });
}

/** Append or update a license record, idempotent by (buyer, author). Returns true when added. */
export function appendLicense(file: string, rec: LicenseRecord): boolean {
  return withFileLock(file, () => {
    const cur = JSON.parse(fs.readFileSync(file, "utf8"));
    const list: LicenseRecord[] = Array.isArray(cur.licenses) ? cur.licenses : [];
    const i = list.findIndex((l) => l.buyer === rec.buyer && l.author === rec.author);
    if (i >= 0) {
      const merged = { ...list[i], ...rec };
      if (list[i].scheduled !== false || rec.scheduled !== false) merged.scheduled = true;
      list[i] = merged;
    } else {
      list.push(rec);
    }
    cur.licenses = list;
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(cur, null, 2));
    fs.renameSync(tmp, file);
    return i < 0;
  });
}
