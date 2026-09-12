/**
 * The devnet test-USDC faucet, run in the visitor's own tab.
 *
 * A round's "USDC" is a test mint with six decimals and no value. Its mint
 * authority is a throwaway keypair committed at
 * `packages/sdk/src/devnet-faucet.json` on purpose: a judge arriving with
 * nothing but a browser wallet has to be able to get some and actually use the
 * product, and the only way to co-sign a mint in a browser is to ship the key.
 *
 * What that key can do: mint this one worthless devnet token.
 * What it cannot do: it is not the round admin, not the program upgrade
 * authority, it holds no funds and it signs nothing else.
 *
 * The visitor's wallet is the fee payer and pays the rent for its own token
 * account; the faucet key only signs `mint_to`.
 */
import { Keypair, PublicKey, type Connection, type TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction } from "@solana/spl-token";
import faucetSecret from "@blackbox/sdk/src/devnet-faucet.json";
import { ata } from "./espl";

/** How much one click hands out: 1,000 test USDC. */
export const FAUCET_AMOUNT = 1_000_000_000n;

/** Rent for a fresh associated token account plus one signature, in SOL. */
export const FAUCET_COST_SOL = 0.00204;

let cached: Keypair | null = null;

/** The committed mint authority. Lazy so the module is safe to import during prerender. */
export function faucetKeypair(): Keypair {
  cached ??= Keypair.fromSecretKey(Uint8Array.from(faucetSecret as number[]));
  return cached;
}

export function faucetAuthority(): PublicKey {
  return faucetKeypair().publicKey;
}

/**
 * Create `owner`'s associated token account if it is missing and mint `amount`
 * to it. The same pair of instructions `BlackboxClient.mintTestUsdc` sends,
 * with the visitor as payer instead of the admin.
 */
export function faucetMintIxs(mint: PublicKey, owner: PublicKey, amount: bigint = FAUCET_AMOUNT): TransactionInstruction[] {
  const dest = ata(mint, owner);
  return [createAssociatedTokenAccountIdempotentInstruction(owner, dest, owner, mint), createMintToInstruction(mint, dest, faucetAuthority(), amount)];
}

/**
 * The mint authority in an SPL mint account: `COption<Pubkey>` at offset 0
 * (u32 tag, then 32 bytes). Null when the mint is fixed supply.
 */
export function decodeMintAuthority(data: Uint8Array | null | undefined): string | null {
  if (!data || data.length < 82) return null;
  const tag = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, true);
  return tag === 1 ? new PublicKey(data.subarray(4, 36)).toBase58() : null;
}

export type FaucetStatus =
  | { ok: true; authority: string }
  /** The mint exists but someone else controls it, so the shipped key cannot mint. */
  | { ok: false; reason: "authority"; authority: string | null }
  | { ok: false; reason: "missing" }
  | { ok: false; reason: "error"; detail: string };

/** Can the shipped key mint this mint right now? Read once before offering the button. */
export async function checkFaucet(connection: Connection, mint: PublicKey): Promise<FaucetStatus> {
  try {
    const info = await connection.getAccountInfo(mint, "confirmed");
    if (!info) return { ok: false, reason: "missing" };
    const authority = decodeMintAuthority(info.data);
    return authority === faucetAuthority().toBase58() ? { ok: true, authority } : { ok: false, reason: "authority", authority };
  } catch (e) {
    return { ok: false, reason: "error", detail: e instanceof Error ? e.message : String(e) };
  }
}

/** Why the faucet cannot mint, in one sentence for the UI. */
export function faucetProblem(status: FaucetStatus): string | null {
  if (status.ok) return null;
  if (status.reason === "missing") return "The round's test mint does not exist on this cluster.";
  if (status.reason === "error") return `Could not read the test mint: ${status.detail}.`;
  return `The test mint's authority is ${status.authority ?? "nobody (fixed supply)"}, not the faucet key that ships with this site, so this button cannot mint. Ask the round operator for test USDC.`;
}
