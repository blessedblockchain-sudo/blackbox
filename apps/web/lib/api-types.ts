/** Wire types shared by the route handlers and the client. No secrets ever cross this boundary. */
import type { LicenseView, PositionView, StrategyView } from "./chain";

export type Cluster = "local" | "devnet";

export interface PublicEntrant {
  name: string;
  owner: string;
  bot: boolean;
  external: boolean;
  /** The local server holds this identity's key and can read or hot-swap as it. */
  canActAs: boolean;
}

export interface PublicRoundInfo {
  cluster: Cluster;
  source: "file" | "env" | "none";
  roundId: number | null;
  round: string | null;
  mint: string | null;
  feeds: string[];
  markets: string[];
  tickMs: number | null;
  durationTicks: number | null;
  mode: "lit" | "dark" | null;
  phase: string | null;
  registrationEndsAt: number | null;
  startedAt: number | null;
  updatedAt: number | null;
  entrants: PublicEntrant[];
  entrantOwners: string[];
  /** Runner-owned wallets that license strategies (names and keys only). */
  backers: PublicBacker[];
  /** Licenses the runner will settle at round end (public: open_license is an L1 transaction). */
  licenses: PublicLicenseRecord[];
  endpoints: { base: string; tee: string };
  indexerUrl: string;
  /** True when /api/local/* will serve this request (local cluster, loopback host). */
  localRoutes: boolean;
}

export interface PublicBacker {
  name: string;
  owner: string;
}

export interface PublicLicenseRecord {
  name: string;
  buyer: string;
  author: string;
  bot: boolean;
  /** true: a crank task exists; false: the runner should schedule it; null: not recorded yet. */
  scheduled: boolean | null;
  source: string | null;
}

// ------------------------------------------------------------ /api/local/back

export type StepStatus = "pending" | "running" | "done" | "skipped" | "error";
export type StepLayer = "l1" | "er" | "wait" | "local";

export interface JobStep {
  key: string;
  label: string;
  layer: StepLayer;
  status: StepStatus;
  sig?: string;
  explorer?: string;
  detail?: string;
  ms?: number;
}

export interface BackJob {
  id: string;
  round: string;
  buyer: string;
  author: string;
  authorName: string;
  /** Margin in USDC. */
  margin: number;
  status: "running" | "done" | "error";
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  steps: JobStep[];
}

export interface BackerLicense {
  author: string;
  authorName: string;
  /** License PDA. */
  license: string;
  scheduled: boolean | null;
  /** Decoded with the backer's TEE token; null when the TEE returned nothing. */
  view: LicenseView | null;
  error: string | null;
}

export interface BackerInfo {
  owner: string;
  name: string;
  /** Where the server keeps the key, relative to the repo (never the key itself). */
  keyFile: string;
  solL1: number | null;
  usdcL1: number | null;
  /** USDC on the rollup (spendable for margin); null before the first deposit. */
  usdcEr: number | null;
}

export interface BackStateResponse {
  round: string;
  roundId: number | null;
  backer: BackerInfo;
  licenses: BackerLicense[];
  jobs: BackJob[];
  /** The authenticated TEE read behind `licenses` (token redacted). */
  read: ReadRequest | null;
  at: number;
}

export interface BackStartRequest {
  author: string;
  /** Decimal USDC string as typed, parsed exactly on the server. */
  margin: string;
}

// ------------------------------------------------------------ /api/proof

/** What the read path returned: data (read), nothing (blocked), an informational row, or no answer (error). */
export type ProofAccess = "read" | "blocked" | "info" | "error";

export interface ProofRow {
  path: string;
  who: string;
  request: string;
  result: string;
  expected: string;
  access: ProofAccess;
  pass: boolean;
}

export interface ProofResponse {
  cluster: Cluster;
  round: string;
  target: string;
  targetName: string;
  /** The owner's key was available, so the owner control rows ran. */
  ownerToken: boolean;
  rival: string | null;
  rows: ProofRow[];
  passed: number;
  failed: number;
  ms: number;
  at: number;
}

// ------------------------------------------------------------ /api/hall

export interface HallRow {
  wallet: string;
  /** Name from the current round file, when the wallet appears there. */
  name: string | null;
  bot: boolean;
  rounds: number;
  wins: number;
  podiums: number;
  /** USD. */
  totalPnl: number;
  elo: number;
  /** Null until the wallet has a recorded rank. */
  bestRank: number | null;
  hall: string;
}

export interface HallResponse {
  cluster: Cluster;
  base: string;
  rows: HallRow[];
  at: number;
}

export interface ReadRequest {
  label: string;
  method: string;
  endpoint: string;
  account: string;
  ms: number;
  found: boolean;
  bytes: number;
  owner: string | null;
}

export type WireStrategy = Omit<StrategyView, "bytecode"> & { bytecodeB64: string; sha256: string };

export interface OwnerReadResponse {
  owner: string;
  round: string;
  strategy: WireStrategy | null;
  position: PositionView | null;
  requests: ReadRequest[];
}

export interface HotSwapResponse {
  sig: string;
  explorer: string;
  version: number | null;
  len: number;
}

export interface ApiError {
  error: string;
}

export function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
