import { expect } from "chai";
import { Keypair, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import {
  delegateSpl,
  deriveEphemeralAta,
  delegationRecordPdaFromDelegatedAccount,
  delegationMetadataPdaFromDelegatedAccount,
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram,
  permissionPdaFromAccount,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import { depositSplIxs, ephemeralAta, delegationRecordPda, delegationMetadataPda, delegateBufferPda, permissionPda, tokenAmount } from "../lib/espl";

const flat = (ixs: TransactionInstruction[]) =>
  ixs.map((ix) => ({
    program: ix.programId.toBase58(),
    keys: ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]),
    data: Buffer.from(ix.data).toString("hex"),
  }));

describe("espl: browser deposit matches the MagicBlock SDK", () => {
  it("derives the same PDAs", () => {
    for (let i = 0; i < 5; i++) {
      const owner = Keypair.generate().publicKey;
      const mint = Keypair.generate().publicKey;
      expect(ephemeralAta(owner, mint).toBase58()).to.equal(deriveEphemeralAta(owner, mint)[0].toBase58());
      expect(delegationRecordPda(owner).toBase58()).to.equal(delegationRecordPdaFromDelegatedAccount(owner).toBase58());
      expect(delegationMetadataPda(owner).toBase58()).to.equal(delegationMetadataPdaFromDelegatedAccount(owner).toBase58());
      expect(delegateBufferPda(owner, mint).toBase58()).to.equal(delegateBufferPdaFromDelegatedAccountAndOwnerProgram(owner, mint).toBase58());
      expect(permissionPda(owner).toBase58()).to.equal(permissionPdaFromAccount(owner).toBase58());
    }
  });

  it("builds the instructions BlackboxClient.depositToEr sends, byte for byte", async () => {
    const validator = new PublicKey("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");
    for (const amount of [1n, 200_000_000n, 18_446_744_073_709_551_615n]) {
      const owner = Keypair.generate().publicKey;
      const mint = Keypair.generate().publicKey;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sdk = await delegateSpl(owner, mint, amount, { validator, idempotent: false, payer: owner, initVaultIfMissing: false } as any);
      expect(flat(depositSplIxs(owner, mint, amount, validator))).to.deep.equal(flat(sdk));
    }
  });

  it("reads an SPL token account amount", () => {
    const data = new Uint8Array(165);
    new DataView(data.buffer).setBigUint64(64, 123_456_789n, true);
    expect(tokenAmount(data)).to.equal(123_456_789n);
    expect(tokenAmount(null)).to.equal(null);
    expect(tokenAmount(new Uint8Array(10))).to.equal(null);
  });
});
