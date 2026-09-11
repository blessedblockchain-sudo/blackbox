/**
 * Browser-safe MagicBlock addresses and the Ephemeral SPL deposit, so wallet
 * flows do not bundle the whole MagicBlock SDK. `depositSplIxs` reproduces
 * `delegateSpl(owner, mint, amount, { validator, idempotent: false, initVaultIfMissing: false })`
 * from @magicblock-labs/ephemeral-rollups-sdk 0.17, which is what
 * `BlackboxClient.depositToEr` sends; test/espl.test.ts pins it byte for byte.
 */
import { Buffer } from "./polyfills";
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";

export const EPHEMERAL_SPL_TOKEN_PROGRAM_ID = new PublicKey("SPLxh1LVZzEkX99H6rqYizhytLWPZVV296zyYDPagv2");
export const DELEGATION_PROGRAM_ID = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
export const PERMISSION_PROGRAM_ID = new PublicKey("ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1");
export const MAGIC_PROGRAM_ID = new PublicKey("Magic11111111111111111111111111111111111111");
export const MAGIC_CONTEXT_ID = new PublicKey("MagicContext1111111111111111111111111111111");
export const EPHEMERAL_VAULT_ID = new PublicKey("MagicVau1t999999999999999999999999999999999");
export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

const enc = (s: string) => new TextEncoder().encode(s);
const find = (seeds: Uint8Array[], program: PublicKey) => PublicKey.findProgramAddressSync(seeds, program)[0];

/** Associated token account (owner may be a PDA). */
export const ata = (mint: PublicKey, owner: PublicKey) => find([owner.toBytes(), TOKEN_PROGRAM_ID.toBytes(), mint.toBytes()], ASSOCIATED_TOKEN_PROGRAM_ID);
export const ephemeralAta = (owner: PublicKey, mint: PublicKey) => find([owner.toBytes(), mint.toBytes()], EPHEMERAL_SPL_TOKEN_PROGRAM_ID);
export const esplVault = (mint: PublicKey) => find([mint.toBytes()], EPHEMERAL_SPL_TOKEN_PROGRAM_ID);
export const delegateBufferPda = (account: PublicKey, ownerProgram: PublicKey) => find([enc("buffer"), account.toBytes()], ownerProgram);
export const delegationRecordPda = (account: PublicKey) => find([enc("delegation"), account.toBytes()], DELEGATION_PROGRAM_ID);
export const delegationMetadataPda = (account: PublicKey) => find([enc("delegation-metadata"), account.toBytes()], DELEGATION_PROGRAM_ID);
export const permissionPda = (account: PublicKey) => find([enc("permission:"), account.toBytes()], PERMISSION_PROGRAM_ID);

const meta = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean) => ({ pubkey, isSigner, isWritable });

function amountData(discriminator: number, amount: bigint): Buffer {
  const data = Buffer.alloc(9);
  data[0] = discriminator;
  data.writeBigUInt64LE(amount, 1);
  return data;
}

/** Ephemeral SPL deposit: init the owner's ephemeral ATA, move `amount` into the mint's vault, delegate it to `validator`. */
export function depositSplIxs(owner: PublicKey, mint: PublicKey, amount: bigint, validator: PublicKey, payer: PublicKey = owner): TransactionInstruction[] {
  const eata = ephemeralAta(owner, mint);
  const vault = esplVault(mint);
  const vaultAta = ata(mint, vault);
  const ownerAta = ata(mint, owner);
  return [
    new TransactionInstruction({
      programId: EPHEMERAL_SPL_TOKEN_PROGRAM_ID,
      keys: [meta(eata, false, true), meta(payer, true, true), meta(owner, false, false), meta(mint, false, false), meta(SystemProgram.programId, false, false)],
      data: Buffer.from([0]),
    }),
    new TransactionInstruction({
      programId: EPHEMERAL_SPL_TOKEN_PROGRAM_ID,
      keys: [
        meta(eata, false, true),
        meta(vault, false, false),
        meta(mint, false, false),
        meta(ownerAta, false, true),
        meta(vaultAta, false, true),
        meta(owner, true, false),
        meta(TOKEN_PROGRAM_ID, false, false),
      ],
      data: amountData(2, amount),
    }),
    new TransactionInstruction({
      programId: EPHEMERAL_SPL_TOKEN_PROGRAM_ID,
      keys: [
        meta(payer, true, true),
        meta(eata, false, true),
        meta(EPHEMERAL_SPL_TOKEN_PROGRAM_ID, false, false),
        meta(delegateBufferPda(eata, EPHEMERAL_SPL_TOKEN_PROGRAM_ID), false, true),
        meta(delegationRecordPda(eata), false, true),
        meta(delegationMetadataPda(eata), false, true),
        meta(DELEGATION_PROGRAM_ID, false, false),
        meta(SystemProgram.programId, false, false),
      ],
      data: Buffer.concat([Buffer.from([4]), Buffer.from(validator.toBytes())]),
    }),
  ];
}

/** SPL token account amount (u64 at offset 64), or null when the data is not a token account. */
export function tokenAmount(data: Uint8Array | null | undefined): bigint | null {
  if (!data || data.length < 72) return null;
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(64, true);
}
