/**
 * Browser-safe chain helpers: PDAs, the Anchor account coder (camelCase, same
 * as the SDK's `program.coder`), typed views of every account the UI shows,
 * and the `set_strategy` instruction. Imports only web3.js and anchor, never
 * the MagicBlock SDK, so the Arena bundle stays small.
 */
import { Buffer } from "./polyfills";
import { Program, type Idl, type Provider } from "@coral-xyz/anchor";
import { ComputeBudgetProgram, Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import idlJson from "@blackbox/sdk/src/blackbox.idl.json";
import { fromMicro, toNum } from "./format";

export const IDL = idlJson as unknown as Idl;
export const PROGRAM_ID = new PublicKey((idlJson as { address: string }).address);

// ------------------------------------------------------------------ PDAs

const u32 = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
};
const enc = (s: string) => new TextEncoder().encode(s);
const pda = (seeds: Uint8Array[]) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];

export const roundPda = (id: number) => pda([enc("round"), u32(id)]);
export const scoreboardPda = (round: PublicKey) => pda([enc("board"), round.toBytes()]);
export const marketPda = (round: PublicKey, index: number) => pda([enc("mkt"), round.toBytes(), Uint8Array.of(index)]);
export const entrantPda = (round: PublicKey, owner: PublicKey) => pda([enc("ent"), round.toBytes(), owner.toBytes()]);
export const strategyPda = (round: PublicKey, owner: PublicKey) => pda([enc("strat"), round.toBytes(), owner.toBytes()]);
export const positionPda = (round: PublicKey, owner: PublicKey) => pda([enc("pos"), round.toBytes(), owner.toBytes()]);
export const licensePda = (round: PublicKey, buyer: PublicKey, author: PublicKey) => pda([enc("lic"), round.toBytes(), buyer.toBytes(), author.toBytes()]);
export const hallPda = (wallet: PublicKey) => pda([enc("hall"), wallet.toBytes()]);
/** The round chat: an ephemeral account that exists only on the rollup, sponsored by the Round. */
export const chatPda = (round: PublicKey) => pda([enc("chat"), round.toBytes()]);

// ------------------------------------------------------------ round chat

/** Layout from programs/blackbox/src/instructions/chat.rs: head u32 | count u32 | 32 x [author 32 | tick u64 | ts i64 | len u8 | text 79]. */
export const CHAT_SLOTS = 32;
export const CHAT_SLOT_SIZE = 128;
export const CHAT_HEADER = 8;
export const CHAT_TEXT_MAX = 79;

export interface ChatMessage {
  author: string;
  tick: number;
  /** Unix seconds on the rollup. */
  ts: number;
  text: string;
}

/** Messages oldest first (same decoding as the SDK's `decodeChat`). */
export function decodeChat(data: Uint8Array): ChatMessage[] {
  if (data.length < CHAT_HEADER + CHAT_SLOTS * CHAT_SLOT_SIZE) return [];
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const head = dv.getUint32(0, true) % CHAT_SLOTS;
  const n = Math.min(dv.getUint32(4, true), CHAT_SLOTS);
  const utf8 = new TextDecoder();
  const out: ChatMessage[] = [];
  for (let k = 0; k < n; k++) {
    const off = CHAT_HEADER + ((head - n + k + CHAT_SLOTS) % CHAT_SLOTS) * CHAT_SLOT_SIZE;
    const len = Math.min(data[off + 48], CHAT_TEXT_MAX);
    out.push({
      author: new PublicKey(data.subarray(off, off + 32)).toBase58(),
      tick: Number(dv.getBigUint64(off + 32, true)),
      ts: Number(dv.getBigInt64(off + 40, true)),
      text: utf8.decode(data.subarray(off + 49, off + 49 + len)),
    });
  }
  return out;
}

/** post_chat's rule: 1 to 79 bytes, no byte below 0x20, no DEL. Null when the text is accepted. */
export function chatTextError(text: string): string | null {
  const bytes = new TextEncoder().encode(text);
  if (!bytes.length) return "Write a message first.";
  if (bytes.length > CHAT_TEXT_MAX) return `Messages are at most ${CHAT_TEXT_MAX} bytes; this one is ${bytes.length}.`;
  if (bytes.some((b) => b < 0x20 || b === 0x7f)) return "Control characters are not allowed.";
  return null;
}

/** `MAX_LICENSES_PER_AUTHOR` in programs/blackbox/src/constants.rs. */
export const MAX_LICENSES_PER_AUTHOR = 8;

// ------------------------------------------------------------------ coder

let program: Program | null = null;
function coderProgram(): Program {
  if (!program) {
    // The coder never touches the provider; a bare connection satisfies the constructor.
    const provider = { connection: new Connection("http://127.0.0.1:1") } as unknown as Provider;
    program = new Program(IDL, provider);
  }
  return program;
}

export type AccountName = "round" | "scoreboard" | "market" | "entrant" | "strategy" | "position" | "license" | "hall";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function decodeAccount(name: AccountName, data: Uint8Array): any {
  return coderProgram().coder.accounts.decode(name, Buffer.from(data));
}

// ------------------------------------------------------------------ views

export type RoundStatus = "created" | "open" | "live" | "settling" | "settled";
export type RoundMode = "lit" | "dark";

export interface MarketConfigView {
  feed: string;
  maxLeverage: number;
  maintenanceBps: number;
  baseSpreadBps: number;
}

export interface RoundView {
  id: number;
  status: RoundStatus;
  mode: RoundMode;
  mint: string;
  /** Margin bounds in USDC (also the bounds of a license's margin). */
  minMargin: number;
  maxMargin: number;
  /** Blind license price range in bps; activation locks max(author price, min). */
  licenseFeeMinBps: number;
  licenseFeeMaxBps: number;
  /** Licenses activated and not yet settled (0 on builds without the counter). */
  openLicenses: number;
  /** ER validator the round is pinned to (delegations must name it). */
  validator: string;
  nMarkets: number;
  markets: MarketConfigView[];
  mysteryMarket: number | null;
  vrfReady: boolean;
  tick: number;
  durationTicks: number;
  tickIntervalMs: number;
  stepLimit: number;
  entrantCount: number;
  settledCount: number;
  entryFee: number;
  pot: number;
  vaultBalance: number;
  totalEquity: number;
  startedAt: number;
  endedAt: number;
}

export interface MarketView {
  index: number;
  mark: number;
  ema8: number;
  ema21: number;
  ema55: number;
  /** Realized per-tick volatility as a fraction (0.0001 = 1 bp). */
  vol: number;
  oiLong: number;
  oiShort: number;
  oiCap: number;
  fundingRateBps: number;
  maxLeverage: number;
  maintenanceBps: number;
  baseSpreadBps: number;
  lastTick: number;
  /** Marks in time order, oldest first (USD). */
  ring: number[];
}

export interface ScoreEntryView {
  index: number;
  owner: string;
  equity: number;
  deposited: number;
  trades: number;
  alive: boolean;
  rank: number;
}

export interface ScoreboardView {
  n: number;
  finalized: boolean;
  entries: ScoreEntryView[];
}

export interface EntrantView {
  owner: string;
  index: number;
  alive: boolean;
  deposited: number;
  strategyVersion: number;
  privatized: boolean;
  settled: boolean;
  /** Hex sha256 of the final strategy, published at settlement (empty before). */
  strategyHash: string;
  /** Blind license price in bps of traded notional, set inside the TEE from the private Sharpe ratio. */
  feePriceBps: number;
  /** Active licenses on this strategy (public counter). */
  licenseCount: number;
}

export interface LegView {
  market: number;
  side: -1 | 0 | 1;
  /** Notional in USD. */
  size: number;
  entry: number;
}

export interface PositionView {
  margin: number;
  realizedPnl: number;
  legs: LegView[];
  mem: string[];
  tradeCount: number;
  lastSteps: number;
  lastFault: number;
  lastFaultPc: number;
  liquidated: boolean;
  lastEquity: number;
  peakEquity: number;
}

export interface StrategyView {
  version: number;
  len: number;
  stepLimit: number;
  updatedTick: number;
  bytecode: Uint8Array;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const enumKey = (v: any): string => (v && typeof v === "object" ? Object.keys(v)[0]?.toLowerCase() ?? "" : String(v).toLowerCase());
const hex = (a: ArrayLike<number>) => Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
const pk = (v: any): string => (v && typeof v.toBase58 === "function" ? v.toBase58() : String(v));

export function toRoundView(r: any): RoundView {
  const n = toNum(r.nMarkets);
  return {
    id: toNum(r.id),
    status: enumKey(r.status) as RoundStatus,
    mode: enumKey(r.mode) as RoundMode,
    mint: pk(r.mint),
    minMargin: fromMicro(r.minMargin),
    maxMargin: fromMicro(r.maxMargin),
    licenseFeeMinBps: toNum(r.licenseFeeMinBps),
    licenseFeeMaxBps: toNum(r.licenseFeeMaxBps),
    openLicenses: Number.isFinite(toNum(r.openLicenses)) ? toNum(r.openLicenses) : 0,
    validator: pk(r.validator),
    nMarkets: n,
    markets: (r.markets as any[]).slice(0, n).map((m) => ({
      feed: pk(m.feed),
      maxLeverage: toNum(m.maxLeverage),
      maintenanceBps: toNum(m.maintenanceBps),
      baseSpreadBps: toNum(m.baseSpreadBps),
    })),
    mysteryMarket: toNum(r.mysteryMarket) < n ? toNum(r.mysteryMarket) : null,
    vrfReady: !!r.vrfReady,
    tick: toNum(r.tick),
    durationTicks: toNum(r.durationTicks),
    tickIntervalMs: toNum(r.tickIntervalMs),
    stepLimit: toNum(r.stepLimit),
    entrantCount: toNum(r.entrantCount),
    settledCount: toNum(r.settledCount),
    entryFee: fromMicro(r.entryFee),
    pot: fromMicro(r.pot),
    vaultBalance: fromMicro(r.vaultBalance),
    totalEquity: fromMicro(r.totalEquity),
    startedAt: toNum(r.startedAt),
    endedAt: toNum(r.endedAt),
  };
}

/** Ring buffer in time order: `ringPos` is the next slot to overwrite (the oldest once full). */
export function orderedRing(ring: ArrayLike<unknown>, ringPos: number, ringLen: number): number[] {
  const size = ring.length;
  const out: number[] = [];
  const start = ringLen < size ? 0 : ringPos;
  for (let i = 0; i < ringLen; i++) out.push(fromMicro(ring[(start + i) % size] as any));
  return out;
}

export function toMarketView(m: any): MarketView {
  return {
    index: toNum(m.index),
    mark: fromMicro(m.mark),
    ema8: fromMicro(m.ema8),
    ema21: fromMicro(m.ema21),
    ema55: fromMicro(m.ema55),
    vol: fromMicro(m.vol),
    oiLong: fromMicro(m.oiLong),
    oiShort: fromMicro(m.oiShort),
    oiCap: fromMicro(m.oiCap),
    fundingRateBps: toNum(m.fundingRateBps),
    maxLeverage: toNum(m.maxLeverage),
    maintenanceBps: toNum(m.maintenanceBps),
    baseSpreadBps: toNum(m.baseSpreadBps),
    lastTick: toNum(m.lastTick),
    ring: orderedRing(m.ring, toNum(m.ringPos), toNum(m.ringLen)),
  };
}

export function toScoreboardView(s: any): ScoreboardView {
  const n = toNum(s.n);
  return {
    n,
    finalized: !!toNum(s.finalized),
    entries: (s.entries as any[]).slice(0, n).map((e, index) => ({
      index,
      owner: pk(e.owner),
      equity: fromMicro(e.equity),
      deposited: fromMicro(e.deposited),
      trades: toNum(e.trades),
      alive: !!toNum(e.alive),
      rank: toNum(e.rank),
    })),
  };
}

export function toEntrantView(e: any): EntrantView {
  const hash = hex(e.strategyHash ?? []);
  return {
    owner: pk(e.owner),
    index: toNum(e.index),
    alive: !!e.alive,
    deposited: fromMicro(e.deposited),
    strategyVersion: toNum(e.strategyVersion),
    privatized: !!e.privatized,
    settled: !!e.settled,
    strategyHash: /^0+$/.test(hash) ? "" : hash,
    feePriceBps: toNum(e.feePriceBps),
    licenseCount: toNum(e.licenseCount),
  };
}

export interface LicenseView {
  round: string;
  buyer: string;
  author: string;
  /** Margin moved into the license custody at activation (USD). */
  margin: number;
  /** Realized PnL net of license fees (USD). */
  realizedPnl: number;
  /** Fees owed to the author, paid at settlement (USD). */
  accruedFees: number;
  legs: LegView[];
  openedTick: number;
  /** Equity the program computed on the last tick it ran this book (USD, net of fees). */
  lastEquity: number;
  peakEquity: number;
  /** Round tick of the last crank run, null before the first run. */
  lastTick: number | null;
  tradeCount: number;
  /** Fee locked at activation, bps of traded notional. */
  feeBps: number;
  active: boolean;
  liquidated: boolean;
  settled: boolean;
  lastFault: number;
  /** Body all zeros: settle_license scrubbed it (the permission is closed). */
  scrubbed: boolean;
}

const DEFAULT_KEY = "11111111111111111111111111111111";

export function toLicenseView(l: any): LicenseView {
  const legs: LegView[] = [];
  (l.legs as any[]).forEach((x, market) => {
    const side = toNum(x.side);
    if (side !== 0 && toNum(x.size) !== 0) legs.push({ market, side: side > 0 ? 1 : -1, size: fromMicro(x.size), entry: fromMicro(x.entry) });
  });
  const ran = toNum(l.ranTick);
  const round = pk(l.round);
  return {
    round,
    buyer: pk(l.buyer),
    author: pk(l.author),
    margin: fromMicro(l.margin),
    realizedPnl: fromMicro(l.realizedPnl),
    accruedFees: fromMicro(l.accruedFees),
    legs,
    openedTick: toNum(l.openedTick),
    lastEquity: fromMicro(l.lastEquity),
    peakEquity: fromMicro(l.peakEquity),
    lastTick: ran > 0 ? ran - 1 : null,
    tradeCount: toNum(l.tradeCount),
    feeBps: toNum(l.feeBps),
    active: toNum(l.active) === 1,
    liquidated: toNum(l.liquidated) !== 0,
    settled: toNum(l.settled) !== 0,
    lastFault: toNum(l.lastFault),
    scrubbed: round === DEFAULT_KEY,
  };
}

/** The fee a license activated now would lock: the author's blind price, floored at the round minimum (license.rs). */
export function lockedFeeBps(feePriceBps: number, licenseFeeMinBps: number): number {
  return Math.max(feePriceBps, licenseFeeMinBps);
}

export function toPositionView(p: any): PositionView {
  const legs: LegView[] = [];
  (p.legs as any[]).forEach((l, market) => {
    const side = toNum(l.side);
    if (side !== 0 && toNum(l.size) !== 0) legs.push({ market, side: side > 0 ? 1 : -1, size: fromMicro(l.size), entry: fromMicro(l.entry) });
  });
  return {
    margin: fromMicro(p.margin),
    realizedPnl: fromMicro(p.realizedPnl),
    legs,
    mem: (p.mem as any[]).map((v) => String(v)),
    tradeCount: toNum(p.tradeCount),
    lastSteps: toNum(p.lastSteps),
    lastFault: toNum(p.lastFault),
    lastFaultPc: toNum(p.lastFaultPc),
    liquidated: !!toNum(p.liquidated),
    lastEquity: fromMicro(p.lastEquity),
    peakEquity: fromMicro(p.peakEquity),
  };
}

export function toStrategyView(s: any): StrategyView {
  const len = toNum(s.len);
  return {
    version: toNum(s.version),
    len,
    stepLimit: toNum(s.stepLimit),
    updatedTick: toNum(s.updatedTick),
    bytecode: Uint8Array.from((s.bytecode as ArrayLike<number>) ?? []).slice(0, len),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** `position.last_fault` is the bxvm Fault discriminant + 1 (0 = none). */
export const FAULTS = [
  "BadVersion",
  "BadOpcode",
  "Truncated",
  "StackUnderflow",
  "StackOverflow",
  "DivByZero",
  "BadJump",
  "BadMarket",
  "BadOperand",
  "StepLimit",
  "TooManyActions",
  "NoData",
] as const;
export const faultName = (code: number) => (code <= 0 ? null : FAULTS[code - 1] ?? `Fault ${code}`);

/** Unrealized PnL of a leg at `mark`: side * size * (mark - entry) / entry (mirrors perps.rs). */
export function legPnl(leg: LegView, mark: number): number {
  if (!leg.side || !leg.size || leg.entry <= 0 || !Number.isFinite(mark)) return 0;
  return (leg.side * leg.size * (mark - leg.entry)) / leg.entry;
}

// ------------------------------------------------------------------ set_strategy

const SET_STRATEGY_DISC = Uint8Array.from([251, 41, 210, 173, 140, 96, 78, 235]);

/** `set_strategy(bytecode)` for the owner, identical to the SDK's (400k CU budget first). */
export function setStrategyIxs(round: PublicKey, owner: PublicKey, bytecode: Uint8Array): TransactionInstruction[] {
  const data = new Uint8Array(8 + 4 + bytecode.length);
  data.set(SET_STRATEGY_DISC, 0);
  new DataView(data.buffer).setUint32(8, bytecode.length, true);
  data.set(bytecode, 12);
  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: false },
      { pubkey: round, isSigner: false, isWritable: false },
      { pubkey: entrantPda(round, owner), isSigner: false, isWritable: true },
      { pubkey: strategyPda(round, owner), isSigner: false, isWritable: true },
    ],
    data: Buffer.from(data),
  });
  return [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix];
}
