/**
 * Shared server state: the agent wallet, a BlackboxClient, layer-aware account
 * reads (L1 while an account is owned by the program, the TEE/ER once it is
 * delegated), the local faucet, and a mutex for transaction-sending tools.
 */
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddressSync, getMint, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { DELEGATION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import { BLACKBOX_PROGRAM_ID, BlackboxClient, pda } from "@blackbox/sdk";
import { Config, loadKeypair } from "./config";
import { RoundFile, entrantNames, marketSymbol, readRoundFile } from "./roundfile";
import { enumName, toBig, toNum } from "./format";

export type Layer = "l1" | "er";
export type AccountName = "round" | "market" | "scoreboard" | "entrant" | "position" | "strategy";

export interface ReadResult<T = any> {
  data: T;
  layer: Layer;
  /** True when the L1 copy is owned by the delegation program. */
  delegated: boolean;
}

export interface TxRecord {
  step: string;
  sig: string;
  layer: Layer;
  link: string;
}

const USDC = 1_000_000n;

export class Ctx {
  readonly kp: Keypair;
  readonly client: BlackboxClient;
  readonly faucet: Keypair | null;
  readonly name: string;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(readonly cfg: Config) {
    this.kp = loadKeypair(cfg.keypairPath);
    this.client = new BlackboxClient(this.kp, cfg.cluster);
    this.faucet = cfg.faucetPath ? loadKeypair(cfg.faucetPath) : null;
    this.name = cfg.agentName || `agent-${this.kp.publicKey.toBase58().slice(0, 4)}`;
  }

  get me(): PublicKey {
    return this.kp.publicKey;
  }

  rf(): RoundFile {
    return readRoundFile(this.cfg.roundFile);
  }

  tryRf(): RoundFile | null {
    try {
      return this.rf();
    } catch {
      return null;
    }
  }

  roundKey(rf: RoundFile): PublicKey {
    return new PublicKey(rf.round);
  }

  symbols(rf: RoundFile | null): string[] {
    return rf ? rf.markets.map(marketSymbol) : ["SOL", "BTC", "ETH"];
  }

  names(rf: RoundFile): Map<string, string> {
    const m = entrantNames(rf);
    if (!m.has(this.me.toBase58())) m.set(this.me.toBase58(), this.name);
    return m;
  }

  /** Serialize transaction-sending tools so concurrent calls never double-send. */
  async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  link(sig: string, layer: Layer): string {
    return this.client.explorerTx(sig, layer === "l1" ? "base" : "er");
  }

  tx(step: string, sig: string, layer: Layer): TxRecord {
    return { step, sig, layer, link: this.link(sig, layer) };
  }

  // ------------------------------------------------------------ reads

  /**
   * Read an account from the right layer. `auth` reads through the caller's
   * TEE token (needed for private accounts); otherwise the public TEE view.
   * `fallbackL1` returns the (possibly stale) L1 copy when the ER has nothing.
   */
  async read<T = any>(key: PublicKey, name: AccountName, opts: { auth?: boolean; fallbackL1?: boolean } = {}): Promise<ReadResult<T> | null> {
    const l1 = await this.client.base.getAccountInfo(key, "confirmed").catch(() => null);
    const decode = (data: Buffer) => this.client.program.coder.accounts.decode(name, data) as T;
    // Every BLACKBOX account is created on L1. Only look on the ER once L1 says
    // it is delegated: an ER read of an account the ER does not own yet makes it
    // clone a plain copy, which is exactly what we must never do before delegation.
    if (!l1) return null;
    if (l1.owner.equals(BLACKBOX_PROGRAM_ID)) return { data: decode(l1.data), layer: "l1", delegated: false };
    const conn: Connection = opts.auth ? await this.client.tee(this.kp) : this.client.teePublic();
    const er = await conn.getAccountInfo(key, "processed").catch(() => null);
    if (er && er.owner.equals(BLACKBOX_PROGRAM_ID)) return { data: decode(er.data), layer: "er", delegated: true };
    if (opts.fallbackL1) {
      try {
        return { data: decode(l1.data), layer: "l1", delegated: true };
      } catch {
        return null;
      }
    }
    return null;
  }

  async round(rf: RoundFile): Promise<ReadResult> {
    const r = await this.read(this.roundKey(rf), "round", { fallbackL1: true });
    if (!r) throw new Error(`Round ${rf.round} not found on ${this.cfg.cluster}. Is the round file stale?`);
    return r;
  }

  async markets(rf: RoundFile, n: number): Promise<any[]> {
    const round = this.roundKey(rf);
    const out = await Promise.all(Array.from({ length: n }, (_, i) => this.read(pda.marketPda(round, i), "market", { fallbackL1: true })));
    return out.map((m, i) => {
      if (!m) throw new Error(`Market ${i} of round ${rf.round} not found`);
      return m.data;
    });
  }

  async scoreboard(rf: RoundFile): Promise<any | null> {
    const r = await this.read(pda.scoreboardPda(this.roundKey(rf)), "scoreboard");
    return r ? r.data : null;
  }

  async entrant(rf: RoundFile, owner: PublicKey = this.me): Promise<ReadResult | null> {
    return this.read(pda.entrantPda(this.roundKey(rf), owner), "entrant", { auth: true, fallbackL1: true });
  }

  /** L1 state of the caller's entrant: missing, joined (program-owned), or delegated. */
  async entrantL1State(rf: RoundFile): Promise<"missing" | "joined" | "delegated"> {
    const info = await this.client.base.getAccountInfo(pda.entrantPda(this.roundKey(rf), this.me), "confirmed");
    if (!info) return "missing";
    return info.owner.equals(BLACKBOX_PROGRAM_ID) ? "joined" : "delegated";
  }

  async position(rf: RoundFile): Promise<any | null> {
    const r = await this.read(pda.positionPda(this.roundKey(rf), this.me), "position", { auth: true });
    return r ? r.data : null;
  }

  async strategy(rf: RoundFile): Promise<any | null> {
    const r = await this.read(pda.strategyPda(this.roundKey(rf), this.me), "strategy", { auth: true });
    return r ? r.data : null;
  }

  async balances(rf: RoundFile | null): Promise<{ sol: number; usdcL1: number | null; usdcEr: number | null }> {
    const sol = (await this.client.base.getBalance(this.me).catch(() => 0)) / LAMPORTS_PER_SOL;
    if (!rf) return { sol, usdcL1: null, usdcEr: null };
    const mint = new PublicKey(rf.mint);
    const usdcL1 = await getAccount(this.client.base, getAssociatedTokenAddressSync(mint, this.me))
      .then((a) => Number(a.amount) / 1e6)
      .catch(() => 0);
    const er = await this.erBalance(mint);
    return { sol, usdcL1, usdcEr: er >= 0n ? Number(er) / 1e6 : null };
  }

  /**
   * True once the agent has deposited into the ER: its ephemeral ATA exists on
   * L1 and is delegated. Before that, never touch the agent's ATA through the
   * ER: a read makes the ER clone it as a plain (non-delegated) account, and
   * later ER transactions that write it (fund_entrant) fail with
   * InvalidWritableAccount.
   */
  async hasErDeposit(mint: PublicKey): Promise<boolean> {
    const info = await this.client.base.getAccountInfo(pda.eataAccounts(this.me, mint).eata, "confirmed").catch(() => null);
    return !!info && info.owner.equals(DELEGATION_PROGRAM_ID);
  }

  /** ER USDC balance (6dp), or -1 when the agent has not deposited into the ER. */
  async erBalance(mint: PublicKey): Promise<bigint> {
    if (!(await this.hasErDeposit(mint))) return -1n;
    return this.client.erTokenBalance(this.kp, mint).catch(() => -1n);
  }

  statusName(r: any): string {
    return enumName(r.status);
  }

  // ------------------------------------------------------------ faucet (local)

  /** Make sure the agent has SOL for rent and fees. Local: faucet transfer or airdrop. */
  async ensureSol(minSol = 0.3): Promise<TxRecord[]> {
    const bal = await this.client.base.getBalance(this.me);
    if (bal >= minSol * LAMPORTS_PER_SOL) return [];
    if (this.cfg.cluster !== "local") {
      throw new Error(`Wallet ${this.me.toBase58()} has ${(bal / LAMPORTS_PER_SOL).toFixed(4)} SOL. Fund it with at least ${minSol} SOL on ${this.cfg.cluster} and retry.`);
    }
    const lamports = Math.round(Math.max(1, minSol * 2) * LAMPORTS_PER_SOL);
    if (this.faucet) {
      const sig = await this.client.sendBase([SystemProgram.transfer({ fromPubkey: this.faucet.publicKey, toPubkey: this.me, lamports })], [this.faucet], "faucet SOL");
      return [this.tx("faucet: SOL", sig, "l1")];
    }
    const sig = await this.client.base.requestAirdrop(this.me, lamports);
    await this.client.base.confirmTransaction(sig, "confirmed");
    return [this.tx("airdrop: SOL", sig, "l1")];
  }

  /** Make sure the agent's L1 USDC ATA holds at least `amount` (6dp). Local: mint from the faucet. */
  async ensureUsdc(rf: RoundFile, amount: bigint, topUpTo: bigint = 1_000n * USDC): Promise<TxRecord[]> {
    const mint = new PublicKey(rf.mint);
    const ata = getAssociatedTokenAddressSync(mint, this.me);
    const bal = await getAccount(this.client.base, ata).then((a) => a.amount).catch(() => 0n);
    if (bal >= amount) return [];
    const need = `${Number(amount) / 1e6} USDC (have ${Number(bal) / 1e6})`;
    if (this.cfg.cluster !== "local") throw new Error(`Wallet ${this.me.toBase58()} needs ${need} of mint ${rf.mint} on ${this.cfg.cluster}.`);
    if (!this.faucet) throw new Error(`Wallet needs ${need}; no faucet keypair configured (set BLACKBOX_FAUCET_KEYPAIR).`);
    const m = await getMint(this.client.base, mint);
    if (!m.mintAuthority || !m.mintAuthority.equals(this.faucet.publicKey)) {
      throw new Error(`Faucet ${this.faucet.publicKey.toBase58()} is not the mint authority of ${rf.mint}; cannot mint test USDC.`);
    }
    await getOrCreateAssociatedTokenAccount(this.client.base, this.faucet, mint, this.me);
    const target = amount > topUpTo ? amount : topUpTo;
    const sig = await mintTo(this.client.base, this.faucet, mint, ata, this.faucet, target - bal);
    return [this.tx(`faucet: mint ${Number(target - bal) / 1e6} test USDC`, sig, "l1")];
  }
}

/** Entry economics read from the Round account. */
export function roundEconomics(r: any) {
  return {
    entryFee: toBig(r.entryFee),
    minMargin: toBig(r.minMargin),
    maxMargin: toBig(r.maxMargin),
    stepLimit: toNum(r.stepLimit),
    tickIntervalMs: toNum(r.tickIntervalMs),
  };
}
