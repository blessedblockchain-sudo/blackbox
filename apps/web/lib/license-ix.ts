/**
 * Browser-safe builders for the blind-licensing instructions, encoded from the
 * IDL with the same account order and signer/writable flags as
 * `BlackboxClient` (`program.methods...accountsPartial(...)`); test/license-ix.test.ts
 * compares them. Used by the devnet wallet flow on /back; the local flow signs
 * server-side with BlackboxClient.
 */
import { BN, BorshInstructionCoder } from "@coral-xyz/anchor";
import { ComputeBudgetProgram, PublicKey, TransactionInstruction, type AccountMeta } from "@solana/web3.js";
import { IDL, PROGRAM_ID, entrantPda, licensePda, marketPda, strategyPda } from "./chain";
import { EPHEMERAL_SPL_TOKEN_PROGRAM_ID, ata, delegateBufferPda, delegationMetadataPda, delegationRecordPda, ephemeralAta, permissionPda } from "./espl";

interface IdlAccount {
  name: string;
  writable?: boolean;
  signer?: boolean;
  address?: string;
}
interface IdlIx {
  name: string;
  accounts: IdlAccount[];
}

let coder: BorshInstructionCoder | null = null;

/** Encode `name` (snake_case, as in the IDL) with `args` and named accounts; `address` accounts fill themselves. */
export function buildIx(name: string, args: Record<string, unknown>, accounts: Record<string, PublicKey>, remaining: AccountMeta[] = []): TransactionInstruction {
  const def = (IDL.instructions as unknown as IdlIx[]).find((i) => i.name === name);
  if (!def) throw new Error(`unknown instruction ${name}`);
  const keys = def.accounts.map((a) => {
    const pubkey = accounts[a.name] ?? (a.address ? new PublicKey(a.address) : null);
    if (!pubkey) throw new Error(`${name}: missing account ${a.name}`);
    return { pubkey, isSigner: !!a.signer, isWritable: !!a.writable };
  });
  coder ??= new BorshInstructionCoder(IDL);
  return new TransactionInstruction({ programId: PROGRAM_ID, keys: [...keys, ...remaining], data: coder.encode(name, args) });
}

const cu = (units: number) => ComputeBudgetProgram.setComputeUnitLimit({ units });

/** L1: create the buyer's License on `author`, its custody ATA and the custody's ephemeral ATA. */
export function openLicenseIxs(round: PublicKey, mint: PublicKey, buyer: PublicKey, author: PublicKey): TransactionInstruction[] {
  const license = licensePda(round, buyer, author);
  const eata = ephemeralAta(license, mint);
  return [
    cu(400_000),
    buildIx(
      "open_license",
      {},
      {
        buyer,
        round,
        author_entrant: entrantPda(round, author),
        license,
        author,
        mint,
        custody_ata: ata(mint, license),
        custody_eata: eata,
        eata_buffer: delegateBufferPda(eata, EPHEMERAL_SPL_TOKEN_PROGRAM_ID),
        eata_record: delegationRecordPda(eata),
        eata_metadata: delegationMetadataPda(eata),
      },
    ),
  ];
}

/** L1: delegate the License to the round's validator (never auto-committed). */
export function delegateLicenseIxs(round: PublicKey, buyer: PublicKey, author: PublicKey, validator: PublicKey): TransactionInstruction[] {
  const license = licensePda(round, buyer, author);
  return [
    cu(400_000),
    buildIx(
      "delegate_license",
      {},
      {
        buyer,
        round,
        author,
        buffer_license: delegateBufferPda(license, PROGRAM_ID),
        delegation_record_license: delegationRecordPda(license),
        delegation_metadata_license: delegationMetadataPda(license),
        license,
        validator,
      },
    ),
  ];
}

/** ER: permission [buyer, author], margin from the buyer's rollup ATA to custody, fee locked. */
export function activateLicenseIx(round: PublicKey, mint: PublicKey, buyer: PublicKey, author: PublicKey, margin: bigint): TransactionInstruction {
  const license = licensePda(round, buyer, author);
  return buildIx(
    "activate_license",
    { margin: new BN(margin.toString()) },
    {
      buyer,
      round,
      author_entrant: entrantPda(round, author),
      license,
      permission: permissionPda(license),
      buyer_ata: ata(mint, buyer),
      custody_ata: ata(mint, license),
    },
  );
}

/**
 * ER: close the licence at the final marks, pay the author its accrued fees and
 * return the rest to the buyer. Permissionless, so the buyer can run it on their
 * own licence once the round is settling instead of waiting for the operator.
 */
export function settleLicenseIxs(round: PublicKey, mint: PublicKey, buyer: PublicKey, author: PublicKey, nMarkets: number, payer: PublicKey = buyer): TransactionInstruction[] {
  const license = licensePda(round, buyer, author);
  const remaining: AccountMeta[] = Array.from({ length: nMarkets }, (_, i) => ({ pubkey: marketPda(round, i), isSigner: false, isWritable: true }));
  return [
    cu(800_000),
    buildIx(
      "settle_license",
      {},
      {
        payer,
        round,
        license,
        buyer,
        author,
        custody_ata: ata(mint, license),
        vault_ata: ata(mint, round),
        buyer_ata: ata(mint, buyer),
        author_ata: ata(mint, author),
        permission: permissionPda(license),
      },
      remaining,
    ),
  ];
}

/** ER: one Native Crank task that runs tick_license for the rest of the round. */
export function scheduleLicenseTickIx(round: PublicKey, buyer: PublicKey, author: PublicKey, feeds: PublicKey[], taskId: number, payer: PublicKey): TransactionInstruction {
  const remaining: AccountMeta[] = feeds.flatMap((feed, i) => [
    { pubkey: marketPda(round, i), isSigner: false, isWritable: true },
    { pubkey: feed, isSigner: false, isWritable: false },
  ]);
  return buildIx(
    "schedule_license_tick",
    { task_id: new BN(taskId) },
    { payer, round, author_entrant: entrantPda(round, author), strategy: strategyPda(round, author), license: licensePda(round, buyer, author), buyer },
    remaining,
  );
}
