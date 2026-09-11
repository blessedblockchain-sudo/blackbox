// Unambiguous amounts + an eATA->eATA transfer on the TEE via the SDK.
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, MINT_SIZE, getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction, createInitializeMintInstruction, createMintToInstruction, getMinimumBalanceForRentExemptMint } from "@solana/spl-token";
import { delegateSpl, transferSpl, deriveEphemeralAta, deriveRentPda, getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";
import * as nacl from "tweetnacl";
const TEE = "https://devnet-tee.magicblock.app", EU = "https://devnet-eu.magicblock.app";
const TEE_VALIDATOR = new PublicKey("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo"), EU_VALIDATOR = new PublicKey("MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fmt = (i: any) => !i ? "null" : `owner=${i.owner.toBase58().slice(0, 8)} len=${i.data.length} amt@64=${i.data.length >= 72 ? i.data.readBigUInt64LE(64) : "-"}`;
async function send(conn: Connection, tx: Transaction, signers: Keypair[]) {
  for (let a = 0; ; a++) { try { return await sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" }); } catch (e: any) { if (a < 3 && String(e.message).includes("Blockhash not found")) { await sleep(2000); continue; } throw e; } }
}
async function main() {
  const payer = anchor.Wallet.local().payer;
  const l1 = new Connection("https://api.devnet.solana.com", "confirmed");
  const tok = await getAuthToken(TEE, payer.publicKey, (m: Uint8Array) => Promise.resolve(nacl.sign.detached(m, payer.secretKey)));
  const tee = new Connection(`${TEE}?token=${tok.token}`, "confirmed");
  const eu = new Connection(EU, "confirmed");
  const [rentPda] = deriveRentPda();
  const mint = Keypair.generate();
  const [a, b, c] = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
  const ata = (u: Keypair) => getAssociatedTokenAddressSync(mint.publicKey, u.publicKey);
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: rentPda, lamports: 0.05 * LAMPORTS_PER_SOL }),
    SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey, space: MINT_SIZE, lamports: await getMinimumBalanceForRentExemptMint(l1), programId: TOKEN_PROGRAM_ID }),
    createInitializeMintInstruction(mint.publicKey, 6, payer.publicKey, null));
  for (const u of [a, b, c]) tx.add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: u.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL }), createAssociatedTokenAccountInstruction(payer.publicKey, ata(u), u.publicKey, mint.publicKey), createMintToInstruction(mint.publicKey, ata(u), payer.publicKey, 1_000_000));
  await send(l1, tx, [payer, mint]);
  // a, b -> TEE (legacy), c -> EU (legacy); delegate 300000 each (remainder 700000 on L1)
  for (const [u, v, first] of [[a, TEE_VALIDATOR, true], [b, TEE_VALIDATOR, false], [c, EU_VALIDATOR, false]] as const) {
    const ixs = await delegateSpl(u.publicKey, mint.publicKey, 300_000n, { validator: v, idempotent: false, payer: payer.publicKey, initVaultIfMissing: first });
    await send(l1, new Transaction().add(...ixs), [payer, u]);
  }
  await sleep(3000);
  const show = async (label: string, conn: Connection, u: Keypair) => {
    const [e] = deriveEphemeralAta(u.publicKey, mint.publicKey);
    console.log(`  ${label}: ATA ${fmt(await conn.getAccountInfo(ata(u), "processed").catch(() => null))} | eATA ${fmt(await conn.getAccountInfo(e, "processed").catch(() => null))}`);
  };
  console.log("== after delegating 300000 (L1 remainder 700000)");
  await show("A on TEE", tee, a); await show("B on TEE", tee, b); await show("C on EU ", eu, c); await show("C on L1 ", l1, c);
  // eATA -> eATA transfer on the TEE via SDK
  console.log("== transferSpl A->B 120000 on TEE (public, ephemeral->ephemeral)");
  try {
    const ixs = await transferSpl(a.publicKey, b.publicKey, mint.publicKey, 120_000n, { visibility: "public", fromBalance: "ephemeral", toBalance: "ephemeral" } as any);
    console.log("  ixs:", ixs.length, ixs.map((i: any) => `${i.programId.toBase58().slice(0, 6)}[${i.keys.length} keys, data ${Buffer.from(i.data).toString("hex").slice(0, 24)}]`).join(" "));
    const t = new Transaction().add(...ixs); t.feePayer = a.publicKey; t.recentBlockhash = (await tee.getLatestBlockhash()).blockhash; t.sign(a);
    const sig = await tee.sendRawTransaction(t.serialize(), { skipPreflight: true });
    const conf = await tee.confirmTransaction(sig, "confirmed");
    console.log("  sig", sig.slice(0, 20), "err", JSON.stringify(conf.value.err));
    await sleep(1000);
    await show("A on TEE", tee, a); await show("B on TEE", tee, b);
  } catch (e: any) { console.log("  transfer failed:", String(e.message).slice(0, 300)); }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
