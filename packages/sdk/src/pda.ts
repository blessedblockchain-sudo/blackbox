import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  deriveEphemeralAta,
  delegationRecordPdaFromDelegatedAccount,
  delegationMetadataPdaFromDelegatedAccount,
  permissionPdaFromAccount,
  EPHEMERAL_SPL_TOKEN_PROGRAM_ID,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import { BLACKBOX_PROGRAM_ID } from "./constants";

const pda = (seeds: (Buffer | Uint8Array)[], program = BLACKBOX_PROGRAM_ID) =>
  PublicKey.findProgramAddressSync(seeds, program)[0];

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};

export const configPda = () => pda([Buffer.from("config")]);
export const roundPda = (id: number) => pda([Buffer.from("round"), u32(id)]);
export const scoreboardPda = (round: PublicKey) => pda([Buffer.from("board"), round.toBuffer()]);
export const marketPda = (round: PublicKey, index: number) => pda([Buffer.from("mkt"), round.toBuffer(), Buffer.from([index])]);
export const entrantPda = (round: PublicKey, owner: PublicKey) => pda([Buffer.from("ent"), round.toBuffer(), owner.toBuffer()]);
export const strategyPda = (round: PublicKey, owner: PublicKey) => pda([Buffer.from("strat"), round.toBuffer(), owner.toBuffer()]);
export const positionPda = (round: PublicKey, owner: PublicKey) => pda([Buffer.from("pos"), round.toBuffer(), owner.toBuffer()]);
export const licensePda = (round: PublicKey, buyer: PublicKey, author: PublicKey) =>
  pda([Buffer.from("lic"), round.toBuffer(), buyer.toBuffer(), author.toBuffer()]);
export const hallPda =(wallet: PublicKey) => pda([Buffer.from("hall"), wallet.toBuffer()]);
export const mockFeedPda = (authority: PublicKey, feedId: number) => pda([Buffer.from("mockfeed"), authority.toBuffer(), u32(feedId)]);

export const permissionPda = (account: PublicKey) => permissionPdaFromAccount(account);

/** ATA of an owner (PDAs allowed) for a mint. */
export const ata = (mint: PublicKey, owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true);

/** Ephemeral ATA + its delegation PDAs, for program-owned custody accounts. */
export function eataAccounts(owner: PublicKey, mint: PublicKey) {
  const [eata] = deriveEphemeralAta(owner, mint);
  const [buffer] = PublicKey.findProgramAddressSync([Buffer.from("buffer"), eata.toBuffer()], EPHEMERAL_SPL_TOKEN_PROGRAM_ID);
  return {
    eata,
    buffer,
    record: delegationRecordPdaFromDelegatedAccount(eata),
    metadata: delegationMetadataPdaFromDelegatedAccount(eata),
  };
}
