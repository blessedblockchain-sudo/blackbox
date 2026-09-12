import { expect } from "chai";
import { BN, Program, type Provider } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { IDL, entrantPda, licensePda, marketPda, strategyPda } from "../lib/chain";
import {
  EPHEMERAL_SPL_TOKEN_PROGRAM_ID,
  DELEGATION_PROGRAM_ID,
  EPHEMERAL_VAULT_ID,
  MAGIC_PROGRAM_ID,
  PERMISSION_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  ata,
  delegationMetadataPda,
  delegationRecordPda,
  delegateBufferPda,
  ephemeralAta,
  permissionPda,
} from "../lib/espl";
import { activateLicenseIx, delegateLicenseIxs, openLicenseIxs, scheduleLicenseTickIx, settleLicenseIxs } from "../lib/license-ix";
import { SystemProgram } from "@solana/web3.js";

// The same Program the SDK builds (BlackboxClient.program), with a connection that is never used.
const program = new Program(IDL, { connection: new Connection("http://127.0.0.1:1") } as unknown as Provider);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const methods = program.methods as any;

const flat = (ix: TransactionInstruction) => ({
  program: ix.programId.toBase58(),
  keys: ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]),
  data: Buffer.from(ix.data).toString("hex"),
});

describe("license-ix: browser builders match Anchor (as used by BlackboxClient)", () => {
  const round = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const buyer = Keypair.generate().publicKey;
  const author = Keypair.generate().publicKey;
  const validator = new PublicKey("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");
  const license = licensePda(round, buyer, author);

  it("open_license", async () => {
    const eata = ephemeralAta(license, mint);
    const expected = await methods
      .openLicense()
      .accountsPartial({
        buyer,
        round,
        authorEntrant: entrantPda(round, author),
        license,
        author,
        mint,
        custodyAta: ata(mint, license),
        custodyEata: eata,
        eataBuffer: delegateBufferPda(eata, EPHEMERAL_SPL_TOKEN_PROGRAM_ID),
        eataRecord: delegationRecordPda(eata),
        eataMetadata: delegationMetadataPda(eata),
        ephemeralTokenProgram: EPHEMERAL_SPL_TOKEN_PROGRAM_ID,
        delegationProgram: DELEGATION_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    const ixs = openLicenseIxs(round, mint, buyer, author);
    expect(ixs).to.have.length(2);
    expect(flat(ixs[1])).to.deep.equal(flat(expected));
  });

  it("delegate_license", async () => {
    const expected = await methods.delegateLicense().accountsPartial({ buyer, round, author, license, validator }).instruction();
    const ixs = delegateLicenseIxs(round, buyer, author, validator);
    expect(flat(ixs[1])).to.deep.equal(flat(expected));
  });

  it("activate_license", async () => {
    const margin = 200_000_000n;
    const expected = await methods
      .activateLicense(new BN(margin.toString()))
      .accountsPartial({
        buyer,
        round,
        authorEntrant: entrantPda(round, author),
        license,
        permission: permissionPda(license),
        buyerAta: ata(mint, buyer),
        custodyAta: ata(mint, license),
        permissionProgram: PERMISSION_PROGRAM_ID,
        ephemeralVault: EPHEMERAL_VAULT_ID,
        magicProgram: MAGIC_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
    expect(flat(activateLicenseIx(round, mint, buyer, author, margin))).to.deep.equal(flat(expected));
  });

  it("schedule_license_tick with market and feed remaining accounts", async () => {
    const feeds = [Keypair.generate().publicKey, Keypair.generate().publicKey, Keypair.generate().publicKey];
    const payer = Keypair.generate().publicKey;
    const taskId = 5_123_456_789;
    const expected = await methods
      .scheduleLicenseTick(new BN(taskId))
      .accountsPartial({ payer, round, authorEntrant: entrantPda(round, author), strategy: strategyPda(round, author), license, buyer, magicProgram: MAGIC_PROGRAM_ID })
      .remainingAccounts(feeds.flatMap((f, i) => [{ pubkey: marketPda(round, i), isSigner: false, isWritable: true }, { pubkey: f, isSigner: false, isWritable: false }]))
      .instruction();
    expect(flat(scheduleLicenseTickIx(round, buyer, author, feeds, taskId, payer))).to.deep.equal(flat(expected));
  });

  it("settle_license, which the buyer can send for their own licence", async () => {
    const nMarkets = 3;
    const expected = await methods
      .settleLicense()
      .accountsPartial({
        payer: buyer,
        round,
        license,
        buyer,
        author,
        custodyAta: ata(mint, license),
        vaultAta: ata(mint, round),
        buyerAta: ata(mint, buyer),
        authorAta: ata(mint, author),
        permission: permissionPda(license),
        permissionProgram: PERMISSION_PROGRAM_ID,
        ephemeralVault: EPHEMERAL_VAULT_ID,
        magicProgram: MAGIC_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts(Array.from({ length: nMarkets }, (_, i) => ({ pubkey: marketPda(round, i), isSigner: false, isWritable: true })))
      .instruction();
    const ixs = settleLicenseIxs(round, mint, buyer, author, nMarkets);
    expect(ixs).to.have.length(2);
    expect(flat(ixs[1])).to.deep.equal(flat(expected));
  });
});
