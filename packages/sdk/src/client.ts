/**
 * BlackboxClient: dual-connection client (base layer + TEE/ER) with per-wallet
 * TEE auth tokens, transaction helpers, and one method per protocol step.
 */
import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAccount,
} from "@solana/spl-token";
import {
  getAuthToken,
  verifyTeeRpcIntegrity,
  delegateSpl,
  undelegateIx,
  withdrawSpl,
  MAGIC_PROGRAM_ID,
  MAGIC_CONTEXT_ID,
  PERMISSION_PROGRAM_ID,
  EPHEMERAL_VAULT_ID,
  EPHEMERAL_SPL_TOKEN_PROGRAM_ID,
  DELEGATION_PROGRAM_ID,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import * as nacl from "tweetnacl";
import idl from "./blackbox.idl.json";
import type { Blackbox } from "./blackbox.types";
import { ENDPOINTS, Cluster, BLACKBOX_PROGRAM_ID } from "./constants";
import * as P from "./pda";

export type RoundMode = "lit" | "dark";

export interface CreateRoundParams {
  mode?: RoundMode;
  entryFee: bigint | number;
  minMargin: bigint | number;
  maxMargin: bigint | number;
  tickIntervalMs: number;
  durationTicks: number;
  stepLimit?: number;
  checkpointEveryTicks?: number;
  licenseFeeMinBps?: number;
  licenseFeeMaxBps?: number;
}

export interface MarketParams {
  feed: PublicKey;
  decimals: number;
  maxLeverage: number;
  maintenanceBps: number;
  baseSpreadBps: number;
  skewSpreadBps: number;
  oiCap: bigint | number;
}

export interface ChatMessage {
  author: PublicKey;
  tick: number;
  /** Unix seconds on the ER. */
  ts: number;
  text: string;
}

/** Decode the round chat ring buffer (programs/blackbox/src/instructions/chat.rs), oldest first. */
export function decodeChat(data: Buffer): ChatMessage[] {
  const SLOTS = 32;
  const SLOT = 128;
  const HEADER = 8;
  if (data.length < HEADER + SLOTS * SLOT) return [];
  const head = data.readUInt32LE(0) % SLOTS;
  const n = Math.min(data.readUInt32LE(4), SLOTS);
  const out: ChatMessage[] = [];
  for (let k = 0; k < n; k++) {
    const off = HEADER + ((head - n + k + SLOTS) % SLOTS) * SLOT;
    const len = Math.min(data[off + 48], 79);
    out.push({
      author: new PublicKey(data.subarray(off, off + 32)),
      tick: Number(data.readBigUInt64LE(off + 32)),
      ts: Number(data.readBigInt64LE(off + 40)),
      text: data.subarray(off + 49, off + 49 + len).toString("utf8"),
    });
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const bn = (v: bigint | number) => new BN(v.toString());

class NodeWallet implements anchor.Wallet {
  constructor(readonly payer: Keypair) {}
  get publicKey() { return this.payer.publicKey; }
  async signTransaction<T extends Transaction | anchor.web3.VersionedTransaction>(tx: T): Promise<T> {
    if (tx instanceof Transaction) tx.partialSign(this.payer);
    else tx.sign([this.payer]);
    return tx;
  }
  async signAllTransactions<T extends Transaction | anchor.web3.VersionedTransaction>(txs: T[]): Promise<T[]> {
    return Promise.all(txs.map((t) => this.signTransaction(t)));
  }
}

export class BlackboxClient {
  readonly cluster: Cluster;
  readonly ep: (typeof ENDPOINTS)[Cluster];
  readonly base: Connection;
  readonly program: Program<Blackbox>;
  readonly validator: PublicKey;
  private tokens = new Map<string, { token: string; conn: Connection }>();
  log: (...a: unknown[]) => void = () => {};

  constructor(readonly admin: Keypair, cluster: Cluster = "devnet", overrides: Partial<(typeof ENDPOINTS)[Cluster]> = {}) {
    this.cluster = cluster;
    this.ep = { ...ENDPOINTS[cluster], ...overrides } as any;
    this.base = new Connection(this.ep.base, { wsEndpoint: this.ep.baseWs, commitment: "confirmed" });
    const provider = new anchor.AnchorProvider(this.base, new NodeWallet(admin), { commitment: "confirmed" });
    this.program = new Program<Blackbox>(idl as Blackbox, provider);
    this.validator = this.ep.validator;
  }

  // ------------------------------------------------------------ connections

  /** TEE connection authenticated as `kp` (cached). */
  async tee(kp: Keypair): Promise<Connection> {
    const k = kp.publicKey.toBase58();
    const hit = this.tokens.get(k);
    if (hit) return hit.conn;
    const { token } = await getAuthToken(this.ep.tee, kp.publicKey, (m: Uint8Array) => Promise.resolve(nacl.sign.detached(m, kp.secretKey)));
    const conn = new Connection(`${this.ep.tee}?token=${token}`, { wsEndpoint: `${this.ep.teeWs}?token=${token}`, commitment: "confirmed" });
    this.tokens.set(k, { token, conn });
    return conn;
  }

  /** Unauthenticated TEE connection (sees only public accounts). */
  teePublic(): Connection {
    return new Connection(this.ep.tee, { commitment: "confirmed" });
  }

  async verifyAttestation(): Promise<boolean> {
    if (this.cluster === "local") return true;
    for (let i = 0; i < 3; i++) {
      try { await verifyTeeRpcIntegrity(this.ep.tee); return true; } catch { await sleep(1500); }
    }
    return false;
  }

  explorerTx(sig: string, layer: "base" | "er", token?: string): string {
    if (layer === "base") return `https://explorer.solana.com/tx/${sig}?cluster=${this.cluster === "devnet" ? "devnet" : `custom&customUrl=${encodeURIComponent(this.ep.base)}`}`;
    const url = token ? `${this.ep.tee}?token=${token}` : this.ep.tee;
    return `https://explorer.solana.com/tx/${sig}?cluster=custom&customUrl=${encodeURIComponent(url)}`;
  }

  tokenFor(kp: Keypair): string | undefined { return this.tokens.get(kp.publicKey.toBase58())?.token; }

  // ------------------------------------------------------------ tx helpers

  async sendBase(ixs: TransactionInstruction[], signers: Keypair[], label = "base"): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      const tx = new Transaction().add(...ixs);
      try {
        const sig = await sendAndConfirmTransaction(this.base, tx, signers, { commitment: "confirmed" });
        this.log(`[L1] ${label} ${sig}`);
        return sig;
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        if (attempt < 3 && /Blockhash not found|block height exceeded|429|fetch failed/i.test(msg)) { await sleep(1500 * (attempt + 1)); continue; }
        const logs = e?.logs ?? (typeof e?.getLogs === "function" ? await e.getLogs(this.base).catch(() => null) : null);
        throw new Error(`${label} failed: ${msg}\n${(logs ?? []).slice(-12).join("\n")}`);
      }
    }
  }

  async sendEr(ixs: TransactionInstruction[], signers: Keypair[], label = "er"): Promise<string> {
    const conn = await this.tee(signers[0]);
    for (let attempt = 0; ; attempt++) {
      const tx = new Transaction().add(...ixs);
      tx.feePayer = signers[0].publicKey;
      tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
      tx.sign(...signers);
      const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
      const conf = await conn.confirmTransaction(sig, "confirmed");
      if (!conf.value.err) { this.log(`[ER] ${label} ${sig}`); return sig; }
      if (attempt < 1 && JSON.stringify(conf.value.err).includes("Blockhash")) { await sleep(500); continue; }
      const txd = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }).catch(() => null);
      throw new Error(`${label} failed on ER: ${JSON.stringify(conf.value.err)} ${sig}\n${(txd?.meta?.logMessages ?? []).slice(-15).join("\n")}`);
    }
  }

  private async waitOwner(conn: Connection, key: PublicKey, owner: PublicKey, timeoutMs = 60_000): Promise<void> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const info = await conn.getAccountInfo(key, "confirmed").catch(() => null);
      if (info && info.owner.equals(owner)) return;
      await sleep(1000);
    }
    throw new Error(`timeout waiting for ${key.toBase58()} to be owned by ${owner.toBase58()}`);
  }

  /** Wait until an account is visible on the ER to `kp`. */
  async waitOnEr(kp: Keypair, key: PublicKey, timeoutMs = 45_000): Promise<void> {
    const conn = await this.tee(kp);
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const info = await conn.getAccountInfo(key, "processed").catch(() => null);
      if (info) return;
      await sleep(500);
    }
    throw new Error(`timeout waiting for ${key.toBase58()} on the ER`);
  }

  // ------------------------------------------------------------ L1: protocol + round

  async initProtocol(mint: PublicKey, protocolFeeBps = 500): Promise<string | null> {
    const existing = await this.base.getAccountInfo(P.configPda());
    if (existing) return null;
    const ix = await this.program.methods.initProtocol(protocolFeeBps).accountsPartial({ config: P.configPda(), usdcMint: mint, admin: this.admin.publicKey }).instruction();
    return this.sendBase([ix], [this.admin], "init_protocol");
  }

  async nextRoundId(): Promise<number> {
    const c = await this.program.account.protocolConfig.fetch(P.configPda());
    return c.roundCount;
  }

  async createRound(mint: PublicKey, p: CreateRoundParams): Promise<{ roundId: number; round: PublicKey; sig: string }> {
    const roundId = await this.nextRoundId();
    const round = P.roundPda(roundId);
    const e = P.eataAccounts(round, mint);
    const ix = await this.program.methods
      .createRound({
        mode: p.mode === "dark" ? { dark: {} } : { lit: {} },
        entryFee: bn(p.entryFee),
        minMargin: bn(p.minMargin),
        maxMargin: bn(p.maxMargin),
        tickIntervalMs: p.tickIntervalMs,
        durationTicks: bn(p.durationTicks),
        stepLimit: p.stepLimit ?? 512,
        checkpointEveryTicks: p.checkpointEveryTicks ?? 0,
        licenseFeeMinBps: p.licenseFeeMinBps ?? 5,
        licenseFeeMaxBps: p.licenseFeeMaxBps ?? 100,
      } as any)
      .accountsPartial({
        config: P.configPda(),
        round,
        scoreboard: P.scoreboardPda(round),
        mint,
        vaultAta: P.ata(mint, round),
        vaultEata: e.eata,
        eataBuffer: e.buffer,
        eataRecord: e.record,
        eataMetadata: e.metadata,
        ephemeralTokenProgram: EPHEMERAL_SPL_TOKEN_PROGRAM_ID,
        delegationProgram: DELEGATION_PROGRAM_ID,
        validator: this.validator,
        admin: this.admin.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    const sig = await this.sendBase([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix], [this.admin], `create_round #${roundId}`);
    return { roundId, round, sig };
  }

  async addMarket(round: PublicKey, index: number, m: MarketParams): Promise<string> {
    const ix = await this.program.methods
      .addMarket(index, {
        feed: m.feed,
        decimals: m.decimals,
        maxLeverage: m.maxLeverage,
        maintenanceBps: m.maintenanceBps,
        baseSpreadBps: m.baseSpreadBps,
        skewSpreadBps: m.skewSpreadBps,
        oiCap: bn(m.oiCap),
        enabled: true,
      } as any)
      .accountsPartial({ round, market: P.marketPda(round, index), feed: m.feed, admin: this.admin.publicKey })
      .instruction();
    return this.sendBase([ix], [this.admin], `add_market ${index}`);
  }

  async openRound(round: PublicKey): Promise<string> {
    const ix = await this.program.methods.openRound().accountsPartial({ round, admin: this.admin.publicKey }).instruction();
    return this.sendBase([ix], [this.admin], "open_round");
  }

  async delegateMarkets(roundId: number, nMarkets: number): Promise<string> {
    const round = P.roundPda(roundId);
    const ixs: TransactionInstruction[] = [];
    for (let i = 0; i < nMarkets; i++) {
      ixs.push(await this.program.methods.delegateMarket(roundId, i).accountsPartial({ admin: this.admin.publicKey, round, market: P.marketPda(round, i), validator: this.validator }).instruction());
    }
    return this.sendBase(ixs, [this.admin], "delegate_markets");
  }

  async delegateRound(roundId: number): Promise<string> {
    const round = P.roundPda(roundId);
    const ix = await this.program.methods.delegateRound(roundId).accountsPartial({ admin: this.admin.publicKey, round, scoreboard: P.scoreboardPda(round), validator: this.validator }).instruction();
    return this.sendBase([ix], [this.admin], "delegate_round");
  }

  // ------------------------------------------------------------ L1: entrants

  async join(round: PublicKey, mint: PublicKey, user: Keypair): Promise<string> {
    const entrant = P.entrantPda(round, user.publicKey);
    const e = P.eataAccounts(entrant, mint);
    const ix = await this.program.methods
      .joinRound()
      .accountsPartial({
        round,
        entrant,
        strategy: P.strategyPda(round, user.publicKey),
        position: P.positionPda(round, user.publicKey),
        mint,
        custodyAta: P.ata(mint, entrant),
        custodyEata: e.eata,
        eataBuffer: e.buffer,
        eataRecord: e.record,
        eataMetadata: e.metadata,
        ephemeralTokenProgram: EPHEMERAL_SPL_TOKEN_PROGRAM_ID,
        delegationProgram: DELEGATION_PROGRAM_ID,
        owner: user.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    return this.sendBase([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix], [user], "join_round");
  }

  async delegateEntrant(round: PublicKey, user: Keypair): Promise<string> {
    const ix = await this.program.methods
      .delegateEntrant()
      .accountsPartial({
        owner: user.publicKey,
        round,
        entrant: P.entrantPda(round, user.publicKey),
        strategy: P.strategyPda(round, user.publicKey),
        position: P.positionPda(round, user.publicKey),
        validator: this.validator,
      })
      .instruction();
    return this.sendBase([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix], [user], "delegate_entrant");
  }

  /**
   * User moves `amount` USDC into the ER (their ATA address becomes spendable there).
   * The first deposit delegates the user's ephemeral ATA. A later deposit goes
   * through the eSPL shuttle (the SDK's idempotent path), which the local stack's
   * eSPL program rejects; prefer one deposit per wallet per round.
   */
  async depositToEr(user: Keypair, mint: PublicKey, amount: bigint, payer: Keypair = user, initVault = false): Promise<string> {
    const topUp = await this.hasErDeposit(user.publicKey, mint);
    const ixs = await delegateSpl(user.publicKey, mint, amount, { validator: this.validator, idempotent: topUp, payer: payer.publicKey, initVaultIfMissing: initVault } as any);
    const signers = payer.publicKey.equals(user.publicKey) ? [user] : [payer, user];
    if (!topUp) return this.sendBase(ixs, signers, "delegate_spl");
    try {
      return await this.sendBase(ixs, signers, "delegate_spl (top-up)");
    } catch (e) {
      throw new Error(`A top-up deposit into the ER failed for ${user.publicKey.toBase58()} (it already has an ER deposit). Deposit everything in the first deposit, or use a fresh wallet. ${String((e as Error)?.message ?? e).slice(0, 300)}`);
    }
  }

  async erTokenBalance(user: Keypair, mint: PublicKey): Promise<bigint> {
    const conn = await this.tee(user);
    try { return (await getAccount(conn, P.ata(mint, user.publicKey))).amount; } catch { return -1n; }
  }

  async waitErBalance(user: Keypair, mint: PublicKey, atLeast: bigint, timeoutMs = 60_000): Promise<bigint> {
    const t0 = Date.now();
    let b = -1n;
    while (Date.now() - t0 < timeoutMs) {
      b = await this.erTokenBalance(user, mint);
      if (b >= atLeast) return b;
      await sleep(500);
    }
    throw new Error(`ER balance for ${user.publicKey.toBase58()} stuck at ${b}`);
  }

  // ------------------------------------------------------------ ER: entrant

  private permAccs(round: PublicKey, owner: PublicKey) {
    const strategy = P.strategyPda(round, owner);
    const position = P.positionPda(round, owner);
    return {
      strategy,
      position,
      strategyPermission: P.permissionPda(strategy),
      positionPermission: P.permissionPda(position),
      permissionProgram: PERMISSION_PROGRAM_ID,
      ephemeralVault: EPHEMERAL_VAULT_ID,
      magicProgram: MAGIC_PROGRAM_ID,
    };
  }

  async privatize(round: PublicKey, user: Keypair): Promise<string> {
    const ix = await this.program.methods
      .privatizeEntrant()
      .accountsPartial({ owner: user.publicKey, round, entrant: P.entrantPda(round, user.publicKey), ...this.permAccs(round, user.publicKey) })
      .instruction();
    return this.sendEr([ix], [user], "privatize_entrant");
  }

  async setStrategy(round: PublicKey, user: Keypair, bytecode: Uint8Array): Promise<string> {
    const ix = await this.program.methods
      .setStrategy(Buffer.from(bytecode))
      .accountsPartial({ owner: user.publicKey, round, entrant: P.entrantPda(round, user.publicKey), strategy: P.strategyPda(round, user.publicKey) })
      .instruction();
    return this.sendEr([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix], [user], "set_strategy");
  }

  async fund(round: PublicKey, mint: PublicKey, user: Keypair, margin: bigint): Promise<string> {
    const entrant = P.entrantPda(round, user.publicKey);
    const ix = await this.program.methods
      .fundEntrant(bn(margin))
      .accountsPartial({
        owner: user.publicKey,
        round,
        entrant,
        position: P.positionPda(round, user.publicKey),
        ownerAta: P.ata(mint, user.publicKey),
        custodyAta: P.ata(mint, entrant),
        vaultAta: P.ata(mint, round),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
    return this.sendEr([ix], [user], "fund_entrant");
  }

  // ------------------------------------------------------------ ER: round control

  async setScoreboardPrivacy(round: PublicKey, isPrivate: boolean): Promise<string> {
    const sb = P.scoreboardPda(round);
    const ix = await this.program.methods
      .setScoreboardPrivacy(isPrivate)
      .accountsPartial({ admin: this.admin.publicKey, round, scoreboard: sb, permission: P.permissionPda(sb), permissionProgram: PERMISSION_PROGRAM_ID, ephemeralVault: EPHEMERAL_VAULT_ID, magicProgram: MAGIC_PROGRAM_ID })
      .instruction();
    return this.sendEr([ix], [this.admin], "set_scoreboard_privacy");
  }

  async startRound(round: PublicKey): Promise<string> {
    const ix = await this.program.methods.startRound().accountsPartial({ admin: this.admin.publicKey, round }).instruction();
    return this.sendEr([ix], [this.admin], "start_round");
  }

  async requestSeed(round: PublicKey, clientSeed = 7): Promise<string> {
    const ix = await this.program.methods.requestRoundSeed(clientSeed).accountsPartial({ payer: this.admin.publicKey, round, oracleQueue: this.ep.vrfQueue }).instruction();
    return this.sendEr([ix], [this.admin], "request_round_seed");
  }

  async scheduleClock(round: PublicKey, taskId: number): Promise<string> {
    const ix = await this.program.methods.scheduleClock(new BN(taskId)).accountsPartial({ admin: this.admin.publicKey, round, magicProgram: MAGIC_PROGRAM_ID }).instruction();
    return this.sendEr([ix], [this.admin], "schedule_clock");
  }

  async marketRemaining(round: PublicKey, feeds: PublicKey[], withFeeds = true) {
    const out: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] = [];
    feeds.forEach((f, i) => {
      out.push({ pubkey: P.marketPda(round, i), isSigner: false, isWritable: true });
      if (withFeeds) out.push({ pubkey: f, isSigner: false, isWritable: false });
    });
    return out;
  }

  async scheduleEntrantTick(round: PublicKey, owner: PublicKey, feeds: PublicKey[], taskId: number, payer: Keypair = this.admin): Promise<string> {
    const ix = await this.program.methods
      .scheduleEntrantTick(new BN(taskId))
      .accountsPartial({
        payer: payer.publicKey,
        round,
        scoreboard: P.scoreboardPda(round),
        entrant: P.entrantPda(round, owner),
        strategy: P.strategyPda(round, owner),
        position: P.positionPda(round, owner),
        magicProgram: MAGIC_PROGRAM_ID,
      })
      .remainingAccounts(await this.marketRemaining(round, feeds))
      .instruction();
    return this.sendEr([ix], [payer], "schedule_entrant_tick");
  }

  /** Manually run one tick for an entrant (used when the crank is unavailable, and in tests). */
  async tickEntrant(round: PublicKey, owner: PublicKey, feeds: PublicKey[], payer: Keypair = this.admin): Promise<string> {
    const ix = await this.program.methods
      .tickEntrant()
      .accountsPartial({ round, scoreboard: P.scoreboardPda(round), entrant: P.entrantPda(round, owner), strategy: P.strategyPda(round, owner), position: P.positionPda(round, owner) })
      .remainingAccounts(await this.marketRemaining(round, feeds))
      .instruction();
    return this.sendEr([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }), ix], [payer], "tick_entrant");
  }

  // ------------------------------------------------------------ ER: settlement

  async settle(round: PublicKey, mint: PublicKey, owner: PublicKey, nMarkets: number, payer: Keypair = this.admin): Promise<string> {
    const entrant = P.entrantPda(round, owner);
    const ix = await this.program.methods
      .settleEntrant()
      .accountsPartial({
        payer: payer.publicKey,
        round,
        scoreboard: P.scoreboardPda(round),
        entrant,
        ownerAta: P.ata(mint, owner),
        custodyAta: P.ata(mint, entrant),
        vaultAta: P.ata(mint, round),
        tokenProgram: TOKEN_PROGRAM_ID,
        ...this.permAccs(round, owner),
      })
      .remainingAccounts(Array.from({ length: nMarkets }, (_, i) => ({ pubkey: P.marketPda(round, i), isSigner: false, isWritable: true })))
      .instruction();
    return this.sendEr([ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }), ix], [payer], "settle_entrant");
  }

  async undelegateEntrant(round: PublicKey, owner: PublicKey, payer: Keypair = this.admin): Promise<string> {
    const ix = await this.program.methods
      .undelegateEntrant()
      .accountsPartial({ payer: payer.publicKey, round, entrant: P.entrantPda(round, owner), strategy: P.strategyPda(round, owner), position: P.positionPda(round, owner), magicProgram: MAGIC_PROGRAM_ID, magicContext: MAGIC_CONTEXT_ID })
      .instruction();
    return this.sendEr([ix], [payer], "undelegate_entrant");
  }

  async rank(round: PublicKey): Promise<string> {
    const ix = await this.program.methods.rankRound().accountsPartial({ payer: this.admin.publicKey, round, scoreboard: P.scoreboardPda(round) }).instruction();
    return this.sendEr([ix], [this.admin], "rank_round");
  }

  async payPrizes(round: PublicKey, mint: PublicKey, winners: PublicKey[]): Promise<string> {
    const ix = await this.program.methods
      .payPrizes()
      .accountsPartial({ payer: this.admin.publicKey, round, scoreboard: P.scoreboardPda(round), vaultAta: P.ata(mint, round), tokenProgram: TOKEN_PROGRAM_ID })
      .remainingAccounts(winners.map((w) => ({ pubkey: P.ata(mint, w), isSigner: false, isWritable: true })))
      .instruction();
    return this.sendEr([ix], [this.admin], "pay_prizes");
  }

  async closeRound(round: PublicKey, nMarkets: number): Promise<string> {
    const ix = await this.program.methods
      .closeRound()
      .accountsPartial({ payer: this.admin.publicKey, round, scoreboard: P.scoreboardPda(round), magicProgram: MAGIC_PROGRAM_ID, magicContext: MAGIC_CONTEXT_ID })
      .remainingAccounts(Array.from({ length: nMarkets }, (_, i) => ({ pubkey: P.marketPda(round, i), isSigner: false, isWritable: true })))
      .instruction();
    return this.sendEr([ix], [this.admin], "close_round");
  }

  async waitRoundOnL1(round: PublicKey, timeoutMs = 90_000) {
    await this.waitOwner(this.base, round, BLACKBOX_PROGRAM_ID, timeoutMs);
  }

  async recordHall(round: PublicKey, wallet: PublicKey): Promise<string> {
    const hall = P.hallPda(wallet);
    const ixs = [
      await this.program.methods.initHall().accountsPartial({ hall, wallet, payer: this.admin.publicKey }).instruction(),
      await this.program.methods.recordHall().accountsPartial({ round, scoreboard: P.scoreboardPda(round), hall, entrant: P.entrantPda(round, wallet) }).instruction(),
    ];
    return this.sendBase(ixs, [this.admin], "record_hall");
  }

  /** After settlement: user pulls their USDC back from the ER to L1. */
  async withdrawFromEr(user: Keypair, mint: PublicKey, amount: bigint): Promise<string> {
    await this.sendEr([undelegateIx(user.publicKey, mint)], [user], "undelegate_eata");
    const [eata] = (await import("@magicblock-labs/ephemeral-rollups-sdk")).deriveEphemeralAta(user.publicKey, mint);
    await this.waitOwner(this.base, eata, EPHEMERAL_SPL_TOKEN_PROGRAM_ID, 90_000);
    const ixs = await withdrawSpl(user.publicKey, mint, amount, { idempotent: false } as any);
    return this.sendBase(ixs, [user], "withdraw_spl");
  }

  // ------------------------------------------------------------ blind licensing

  /** L1: create the buyer's License on `author` plus its custody ATA/eATA. */
  async openLicense(round: PublicKey, mint: PublicKey, buyer: Keypair, author: PublicKey): Promise<string> {
    const license = P.licensePda(round, buyer.publicKey, author);
    const e = P.eataAccounts(license, mint);
    const ix = await this.program.methods
      .openLicense()
      .accountsPartial({
        buyer: buyer.publicKey,
        round,
        authorEntrant: P.entrantPda(round, author),
        license,
        author,
        mint,
        custodyAta: P.ata(mint, license),
        custodyEata: e.eata,
        eataBuffer: e.buffer,
        eataRecord: e.record,
        eataMetadata: e.metadata,
        ephemeralTokenProgram: EPHEMERAL_SPL_TOKEN_PROGRAM_ID,
        delegationProgram: DELEGATION_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    return this.sendBase([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix], [buyer], "open_license");
  }

  async delegateLicense(round: PublicKey, buyer: Keypair, author: PublicKey): Promise<string> {
    const ix = await this.program.methods
      .delegateLicense()
      .accountsPartial({ buyer: buyer.publicKey, round, author, license: P.licensePda(round, buyer.publicKey, author), validator: this.validator })
      .instruction();
    return this.sendBase([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix], [buyer], "delegate_license");
  }

  /** ER: make the License private to buyer + author, move margin in, lock the blind price. */
  async activateLicense(round: PublicKey, mint: PublicKey, buyer: Keypair, author: PublicKey, margin: bigint): Promise<string> {
    const license = P.licensePda(round, buyer.publicKey, author);
    const ix = await this.program.methods
      .activateLicense(bn(margin))
      .accountsPartial({
        buyer: buyer.publicKey,
        round,
        authorEntrant: P.entrantPda(round, author),
        license,
        permission: P.permissionPda(license),
        buyerAta: P.ata(mint, buyer.publicKey),
        custodyAta: P.ata(mint, license),
        permissionProgram: PERMISSION_PROGRAM_ID,
        ephemeralVault: EPHEMERAL_VAULT_ID,
        magicProgram: MAGIC_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
    return this.sendEr([ix], [buyer], "activate_license");
  }

  async scheduleLicenseTick(round: PublicKey, buyer: PublicKey, author: PublicKey, feeds: PublicKey[], taskId: number, payer: Keypair = this.admin): Promise<string> {
    const ix = await this.program.methods
      .scheduleLicenseTick(new BN(taskId))
      .accountsPartial({
        payer: payer.publicKey,
        round,
        authorEntrant: P.entrantPda(round, author),
        strategy: P.strategyPda(round, author),
        license: P.licensePda(round, buyer, author),
        buyer,
        magicProgram: MAGIC_PROGRAM_ID,
      })
      .remainingAccounts(await this.marketRemaining(round, feeds))
      .instruction();
    return this.sendEr([ix], [payer], "schedule_license_tick");
  }

  /** Manually run one license tick (the crank normally does this). */
  async tickLicense(round: PublicKey, buyer: PublicKey, author: PublicKey, feeds: PublicKey[], payer: Keypair = this.admin): Promise<string> {
    const ix = await this.program.methods
      .tickLicense()
      .accountsPartial({ round, authorEntrant: P.entrantPda(round, author), strategy: P.strategyPda(round, author), license: P.licensePda(round, buyer, author) })
      .remainingAccounts(await this.marketRemaining(round, feeds))
      .instruction();
    return this.sendEr([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }), ix], [payer], "tick_license");
  }

  /** ER, once the round is settling: close legs, settle PnL with the vault, pay the author's fees, return the rest to the buyer, scrub. */
  async settleLicense(round: PublicKey, mint: PublicKey, buyer: PublicKey, author: PublicKey, nMarkets: number, payer: Keypair = this.admin): Promise<string> {
    const license = P.licensePda(round, buyer, author);
    const ix = await this.program.methods
      .settleLicense()
      .accountsPartial({
        payer: payer.publicKey,
        round,
        license,
        buyer,
        author,
        custodyAta: P.ata(mint, license),
        vaultAta: P.ata(mint, round),
        buyerAta: P.ata(mint, buyer),
        authorAta: P.ata(mint, author),
        permission: P.permissionPda(license),
        permissionProgram: PERMISSION_PROGRAM_ID,
        ephemeralVault: EPHEMERAL_VAULT_ID,
        magicProgram: MAGIC_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts(Array.from({ length: nMarkets }, (_, i) => ({ pubkey: P.marketPda(round, i), isSigner: false, isWritable: true })))
      .instruction();
    return this.sendEr([ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }), ix], [payer], "settle_license");
  }

  async undelegateLicense(round: PublicKey, buyer: PublicKey, author: PublicKey, payer: Keypair = this.admin): Promise<string> {
    const ix = await this.program.methods
      .undelegateLicense()
      .accountsPartial({ payer: payer.publicKey, license: P.licensePda(round, buyer, author), magicProgram: MAGIC_PROGRAM_ID, magicContext: MAGIC_CONTEXT_ID })
      .instruction();
    return this.sendEr([ix], [payer], "undelegate_license");
  }

  // ------------------------------------------------------------ house bankroll

  /**
   * True once `user` has deposited into the ER: their ephemeral ATA exists on L1
   * and is delegated. Read an ER token balance only after this; an earlier ER
   * read makes the ER clone the ATA as a plain account that later writes reject.
   */
  async hasErDeposit(user: PublicKey, mint: PublicKey): Promise<boolean> {
    const info = await this.base.getAccountInfo(P.eataAccounts(user, mint).eata, "confirmed").catch(() => null);
    return !!info && info.owner.equals(DELEGATION_PROGRAM_ID);
  }

  /** ER: `funder` (the house) adds a bankroll to the round vault (counted in the solvency beacon). */
  async seedVault(round: PublicKey, mint: PublicKey, amount: bigint, funder: Keypair = this.admin): Promise<string> {
    const ix = await this.program.methods
      .seedVault(bn(amount))
      .accountsPartial({ funder: funder.publicKey, round, funderAta: P.ata(mint, funder.publicKey), vaultAta: P.ata(mint, round), tokenProgram: TOKEN_PROGRAM_ID })
      .instruction();
    return this.sendEr([ix], [funder], "seed_vault");
  }

  /** ER, after prizes and every license have settled: the admin sends what is left in the vault to `to`'s ATA. */
  async sweepVault(round: PublicKey, mint: PublicKey, to: PublicKey = this.admin.publicKey): Promise<string> {
    const ix = await this.program.methods
      .sweepVault()
      .accountsPartial({ admin: this.admin.publicKey, round, toAta: P.ata(mint, to), vaultAta: P.ata(mint, round), tokenProgram: TOKEN_PROGRAM_ID })
      .instruction();
    return this.sendEr([ix], [this.admin], "sweep_vault");
  }

  // ------------------------------------------------------------ round chat

  /** ER: post a public message (1-79 printable bytes); the first post creates the ephemeral chat account. */
  async postChat(round: PublicKey, author: Keypair, text: string): Promise<string> {
    const ix = await this.program.methods
      .postChat(text)
      .accountsPartial({ author: author.publicKey, round, chat: P.chatPda(round), vault: EPHEMERAL_VAULT_ID, magicProgram: MAGIC_PROGRAM_ID })
      .instruction();
    return this.sendEr([ix], [author], "post_chat");
  }

  /** ER, after trading ends: close the chat so its rent returns to the round before close_round. */
  async closeChat(round: PublicKey): Promise<string> {
    const ix = await this.program.methods
      .closeChat()
      .accountsPartial({ admin: this.admin.publicKey, round, chat: P.chatPda(round), vault: EPHEMERAL_VAULT_ID, magicProgram: MAGIC_PROGRAM_ID })
      .instruction();
    return this.sendEr([ix], [this.admin], "close_chat");
  }

  async fetchChat(round: PublicKey, conn?: Connection): Promise<ChatMessage[]> {
    const info = await (conn ?? this.teePublic()).getAccountInfo(P.chatPda(round), "processed");
    return info ? decodeChat(info.data) : [];
  }

  // ------------------------------------------------------------ local mock feeds

  async initMockFeed(feedId: number, rawPrice: bigint, decimals: number): Promise<PublicKey> {
    const feed = P.mockFeedPda(this.admin.publicKey, feedId);
    if (!(await this.base.getAccountInfo(feed))) {
      const ix = await this.program.methods.initMockFeed(feedId, bn(rawPrice), decimals).accountsPartial({ authority: this.admin.publicKey, feed }).instruction();
      await this.sendBase([ix], [this.admin], `init_mock_feed ${feedId}`);
    }
    return feed;
  }

  async delegateMockFeed(feedId: number): Promise<string> {
    const feed = P.mockFeedPda(this.admin.publicKey, feedId);
    const ix = await this.program.methods.delegateMockFeed(feedId).accountsPartial({ authority: this.admin.publicKey, feed, validator: this.validator }).instruction();
    return this.sendBase([ix], [this.admin], `delegate_mock_feed ${feedId}`);
  }

  async setMockFeed(feed: PublicKey, rawPrice: bigint, decimals: number): Promise<string> {
    const ix = await this.program.methods.setMockFeed(bn(rawPrice), decimals).accountsPartial({ authority: this.admin.publicKey, feed }).instruction();
    return this.sendEr([ix], [this.admin], "set_mock_feed");
  }

  // ------------------------------------------------------------ reads

  async fetchRound(round: PublicKey, conn?: Connection) {
    const c = conn ?? this.teePublic();
    const info = await c.getAccountInfo(round, "processed");
    if (!info) return null;
    return this.program.coder.accounts.decode("round", info.data);
  }

  async fetchScoreboard(round: PublicKey, conn?: Connection) {
    const c = conn ?? this.teePublic();
    const info = await c.getAccountInfo(P.scoreboardPda(round), "processed");
    if (!info) return null;
    return this.program.coder.accounts.decode("scoreboard", info.data);
  }

  async fetchPosition(round: PublicKey, owner: Keypair) {
    const conn = await this.tee(owner);
    const info = await conn.getAccountInfo(P.positionPda(round, owner.publicKey), "processed");
    if (!info) return null;
    return this.program.coder.accounts.decode("position", info.data);
  }

  async fetchStrategy(round: PublicKey, owner: Keypair) {
    const conn = await this.tee(owner);
    const info = await conn.getAccountInfo(P.strategyPda(round, owner.publicKey), "processed");
    if (!info) return null;
    return this.program.coder.accounts.decode("strategy", info.data);
  }

  /** Entrants are public: blind fee price, license count, published hash. */
  async fetchEntrant(round: PublicKey, owner: PublicKey) {
    const info = await this.teePublic().getAccountInfo(P.entrantPda(round, owner), "processed");
    if (!info) return null;
    return this.program.coder.accounts.decode("entrant", info.data);
  }

  /** A License is readable only by its buyer and its author, through their TEE tokens. */
  async fetchLicense(round: PublicKey, viewer: Keypair, buyer: PublicKey, author: PublicKey) {
    const conn = await this.tee(viewer);
    const info = await conn.getAccountInfo(P.licensePda(round, buyer, author), "processed");
    if (!info) return null;
    return this.program.coder.accounts.decode("license", info.data);
  }

  async fetchMarket(round: PublicKey, index: number) {
    const info = await this.teePublic().getAccountInfo(P.marketPda(round, index), "processed");
    if (!info) return null;
    return this.program.coder.accounts.decode("market", info.data);
  }
}
