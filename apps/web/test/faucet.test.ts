import { expect } from "chai";
import { Keypair, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { FAUCET_AMOUNT, decodeMintAuthority, faucetAuthority, faucetKeypair, faucetMintIxs, faucetProblem } from "../lib/faucet";
import { ata } from "../lib/espl";

const flat = (ixs: TransactionInstruction[]) =>
  ixs.map((ix) => ({
    program: ix.programId.toBase58(),
    keys: ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]),
    data: Buffer.from(ix.data).toString("hex"),
  }));

/** An SPL mint account with `authority` as its mint authority. */
function mintAccount(authority: PublicKey | null): Uint8Array {
  const data = new Uint8Array(82);
  const dv = new DataView(data.buffer);
  if (authority) {
    dv.setUint32(0, 1, true);
    data.set(authority.toBytes(), 4);
  }
  data[44] = 6;
  data[45] = 1;
  return data;
}

describe("faucet: browser-side test-USDC mint", () => {
  it("ships a usable keypair whose public key is stable", () => {
    const a = faucetKeypair();
    const b = faucetKeypair();
    expect(a.publicKey.toBase58()).to.equal(b.publicKey.toBase58());
    expect(a.secretKey).to.have.length(64);
    expect(faucetAuthority().toBase58()).to.equal(a.publicKey.toBase58());
  });

  it("builds create-ATA-idempotent + mint_to, byte for byte, with the visitor as payer", () => {
    for (const amount of [1n, FAUCET_AMOUNT, 18_446_744_073_709_551_615n]) {
      const owner = Keypair.generate().publicKey;
      const mint = Keypair.generate().publicKey;
      const dest = getAssociatedTokenAddressSync(mint, owner);
      const expected = [createAssociatedTokenAccountIdempotentInstruction(owner, dest, owner, mint), createMintToInstruction(mint, dest, faucetAuthority(), amount)];
      expect(flat(faucetMintIxs(mint, owner, amount))).to.deep.equal(flat(expected));
      expect(dest.toBase58()).to.equal(ata(mint, owner).toBase58());
    }
  });

  it("mints to the connected wallet, never to the faucet key", () => {
    const owner = Keypair.generate().publicKey;
    const mint = Keypair.generate().publicKey;
    const [createAta, mintTo] = faucetMintIxs(mint, owner);
    // payer, ata, owner, mint, system, token program
    expect(createAta.keys[0].pubkey.toBase58()).to.equal(owner.toBase58());
    expect(createAta.keys[2].pubkey.toBase58()).to.equal(owner.toBase58());
    // mint, destination, authority
    expect(mintTo.keys[1].pubkey.toBase58()).to.equal(ata(mint, owner).toBase58());
    expect(mintTo.keys[2].pubkey.toBase58()).to.equal(faucetAuthority().toBase58());
    expect(mintTo.keys[2].isSigner).to.equal(true);
  });

  it("defaults to 1,000 test USDC", () => {
    expect(FAUCET_AMOUNT).to.equal(1_000_000_000n);
  });

  it("reads the mint authority out of an SPL mint account", () => {
    const authority = Keypair.generate().publicKey;
    expect(decodeMintAuthority(mintAccount(authority))).to.equal(authority.toBase58());
    expect(decodeMintAuthority(mintAccount(null))).to.equal(null);
    expect(decodeMintAuthority(new Uint8Array(40))).to.equal(null);
    expect(decodeMintAuthority(null)).to.equal(null);
  });

  it("explains every reason the button cannot mint", () => {
    const other = Keypair.generate().publicKey.toBase58();
    expect(faucetProblem({ ok: true, authority: faucetAuthority().toBase58() })).to.equal(null);
    expect(faucetProblem({ ok: false, reason: "missing" })).to.contain("does not exist");
    expect(faucetProblem({ ok: false, reason: "authority", authority: other })).to.contain(other);
    expect(faucetProblem({ ok: false, reason: "authority", authority: null })).to.contain("fixed supply");
    expect(faucetProblem({ ok: false, reason: "error", detail: "429" })).to.contain("429");
  });
});
