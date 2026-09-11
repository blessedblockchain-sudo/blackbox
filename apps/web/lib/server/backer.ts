/**
 * The local web backer: a server-held identity that licenses strategies from
 * the /back page on a local round. Its key lives in `.mb/web/backer-local.json`
 * (`.mb` is gitignored) and never leaves the server. Local funding comes from
 * the admin keypair, which is the test USDC mint authority.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction, getAccount, getAssociatedTokenAddressSync, getMint } from "@solana/spl-token";
import type { BlackboxClient } from "@blackbox/sdk";
import { findRoundFile } from "./round-file";

export const BACKER_NAME = "Web backer";
const USDC = 1_000_000n;
/**
 * The first deposit into the rollup. The SDK deposit path (`depositToEr`)
 * initializes and delegates the wallet's ephemeral ATA, so the backer deposits
 * once and later licenses draw on its rollup balance.
 */
export const FIRST_DEPOSIT = 2_000n * USDC;

function mbDir(): string {
  const rf = findRoundFile("local");
  if (!rf) throw new Error("no local round file (.mb/round-local.json)");
  return path.dirname(rf);
}

export function backerKeyPath(): string {
  return path.join(mbDir(), "web", "backer-local.json");
}

/** Repo-relative path for display (".mb/web/backer-local.json"). */
export function displayPath(p: string): string {
  return path.relative(path.dirname(mbDir()), p) || p;
}

function readKeypair(file: string): Keypair {
  const arr = JSON.parse(fs.readFileSync(/*turbopackIgnore: true*/ file, "utf8")) as unknown;
  if (!Array.isArray(arr) || arr.length !== 64) throw new Error(`${file} is not a 64-byte keypair file`);
  return Keypair.fromSecretKey(Uint8Array.from(arr as number[]));
}

/** Load the backer key, creating it (mode 0600, never overwritten) on first use. */
export function loadOrCreateBacker(): { kp: Keypair; file: string } {
  const file = backerKeyPath();
  if (fs.existsSync(/*turbopackIgnore: true*/ file)) return { kp: readKeypair(file), file };
  const kp = Keypair.generate();
  fs.mkdirSync(/*turbopackIgnore: true*/ path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(/*turbopackIgnore: true*/ file, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600, flag: "wx" });
    return { kp, file };
  } catch (e) {
    // Another request created it first: use theirs.
    if ((e as NodeJS.ErrnoException)?.code === "EEXIST") return { kp: readKeypair(file), file };
    throw e;
  }
}

export function adminKeyPath(): string {
  const p = process.env.BLACKBOX_FAUCET_KEYPAIR ?? process.env.ANCHOR_WALLET ?? path.join(os.homedir(), ".config/solana/id.json");
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

/** The round admin (mint authority of the local test USDC). Server-only. */
export function loadAdmin(): Keypair {
  const p = adminKeyPath();
  if (!fs.existsSync(/*turbopackIgnore: true*/ p)) throw new Error(`admin keypair not found at ${p} (set BLACKBOX_FAUCET_KEYPAIR)`);
  return readKeypair(p);
}

/** Top the wallet up to about 2 SOL: local airdrop, or a transfer from the admin if the faucet refuses. */
export async function ensureSol(bx: BlackboxClient, who: PublicKey, admin: Keypair, minSol = 0.5): Promise<{ sig: string; how: string } | null> {
  const bal = await bx.base.getBalance(who, "confirmed");
  if (bal >= minSol * LAMPORTS_PER_SOL) return null;
  try {
    const sig = await bx.base.requestAirdrop(who, 2 * LAMPORTS_PER_SOL);
    const conf = await bx.base.confirmTransaction(sig, "confirmed");
    if (conf.value.err) throw new Error(JSON.stringify(conf.value.err));
    return { sig, how: "airdropped 2 SOL" };
  } catch {
    const sig = await bx.sendBase([SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: who, lamports: 2 * LAMPORTS_PER_SOL })], [admin], "fund backer SOL");
    return { sig, how: "2 SOL from the admin (airdrop refused)" };
  }
}

/** Make the wallet's L1 USDC ATA hold at least `need` (6-dp units), minting the difference as the admin. */
export async function ensureUsdc(bx: BlackboxClient, who: PublicKey, admin: Keypair, mint: PublicKey, need: bigint): Promise<{ sig: string; minted: bigint } | null> {
  const ata = getAssociatedTokenAddressSync(mint, who);
  const bal = await getAccount(bx.base, ata, "confirmed")
    .then((a) => a.amount)
    .catch(() => 0n);
  if (bal >= need) return null;
  const m = await getMint(bx.base, mint, "confirmed");
  if (!m.mintAuthority || !m.mintAuthority.equals(admin.publicKey)) {
    throw new Error(`${admin.publicKey.toBase58()} is not the mint authority of ${mint.toBase58()}; cannot mint test USDC`);
  }
  const minted = need - bal;
  const sig = await bx.sendBase(
    [createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, ata, who, mint), createMintToInstruction(mint, ata, admin.publicKey, minted)],
    [admin],
    "faucet: mint test USDC",
  );
  return { sig, minted };
}
