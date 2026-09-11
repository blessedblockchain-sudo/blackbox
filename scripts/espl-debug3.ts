// Does the TEE hide synthesized token accounts from non-owners? Read with the owners' own tokens.
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, MINT_SIZE, getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction, createInitializeMintInstruction, createMintToInstruction, getMinimumBalanceForRentExemptMint } from "@solana/spl-token";
import { delegateSpl, transferSpl, deriveEphemeralAta, deriveRentPda, getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";
import * as nacl from "tweetnacl";
import * as fs from "fs";
const TEE = "https://devnet-tee.magicblock.app";
const TEE_VALIDATOR = new PublicKey("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fmt = (i: any) => !i ? "null" : `owner=${i.owner.toBase58().slice(0, 8)} len=${i.data.length} amt@64=${i.data.length >= 72 ? i.data.readBigUInt64LE(64) : "-"}`;
async function send(conn: Connection, tx: Transaction, signers: Keypair[]) {
  for (let a = 0; ; a++) { try { return await sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" }); } catch (e: any) { if (a < 3 && String(e.message).includes("Blockhash not found")) { await sleep(2000); continue; } throw e; } }
}
async function teeConn(k: Keypair) {
  const tok = await getAuthToken(TEE, k.publicKey, (m: Uint8Array) => Promise.resolve(nacl.sign.detached(m, k.secretKey)));
  return new Connection(`${TEE}?token=${tok.token}`, "confirmed");
}
async function main() {
  const payer = anchor.Wallet.local().payer;
  const l1 = new Connection("https://api.devnet.solana.com", "confirmed");
  const mint = Keypair.generate(), a = Keypair.generate(), b = Keypair.generate();
  fs.mkdirSync(".mb", { recursive: true });
  fs.writeFileSync(".mb/espl-debug3-keys.json", JSON.stringify({ mint: [...mint.secretKey], a: [...a.secretKey], b: [...b.secretKey] }));
  const ata = (u: Keypair) => getAssociatedTokenAddressSync(mint.publicKey, u.publicKey);
  const [rentPda] = deriveRentPda();
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: rentPda, lamports: 0.05 * LAMPORTS_PER_SOL }),
    SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey, space: MINT_SIZE, lamports: await getMinimumBalanceForRentExemptMint(l1), programId: TOKEN_PROGRAM_ID }),
    createInitializeMintInstruction(mint.publicKey, 6, payer.publicKey, null));
  for (const u of [a, b]) tx.add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: u.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL }), createAssociatedTokenAccountInstruction(payer.publicKey, ata(u), u.publicKey, mint.publicKey), createMintToInstruction(mint.publicKey, ata(u), payer.publicKey, 1_000_000));
  await send(l1, tx, [payer, mint]);
  for (const [u, first] of [[a, true], [b, false]] as const) {
    const ixs = await delegateSpl(u.publicKey, mint.publicKey, 300_000n, { validator: TEE_VALIDATOR, idempotent: false, payer: payer.publicKey, initVaultIfMissing: first });
    await send(l1, new Transaction().add(...ixs), [payer, u]);
  }
  await sleep(3000);
  const [teeA, teeB, teePayer] = await Promise.all([teeConn(a), teeConn(b), teeConn(payer)]);
  const show = async (label: string, conn: Connection, u: Keypair) => {
    const [e] = deriveEphemeralAta(u.publicKey, mint.publicKey);
    console.log(`  ${label}: ATA ${fmt(await conn.getAccountInfo(ata(u), "processed").catch((x: any) => "ERR " + x.message.slice(0, 40)))} | eATA ${fmt(await conn.getAccountInfo(e, "processed").catch(() => null))}`);
  };
  console.log("== before transfer");
  await show("A via A-token   ", teeA, a); await show("A via payer-tok ", teePayer, a); await show("B via B-token   ", teeB, b);
  const ixs = await transferSpl(a.publicKey, b.publicKey, mint.publicKey, 120_000n, { visibility: "public", fromBalance: "ephemeral", toBalance: "ephemeral" } as any);
  const t = new Transaction().add(...ixs); t.feePayer = a.publicKey; t.recentBlockhash = (await teeA.getLatestBlockhash()).blockhash; t.sign(a);
  const sig = await teeA.sendRawTransaction(t.serialize(), { skipPreflight: true });
  const conf = await teeA.confirmTransaction(sig, "confirmed");
  console.log("== transfer A->B 120000 sig", sig, "err", JSON.stringify(conf.value.err));
  await sleep(1500);
  console.log("== after transfer");
  await show("A via A-token   ", teeA, a); await show("B via B-token   ", teeB, b); await show("B via payer-tok ", teePayer, b);
  const txi = await teeA.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  console.log("== tx logs (A token):", txi ? txi.meta?.logMessages : "null");
  console.log("   pre/post token balances:", JSON.stringify(txi?.meta?.preTokenBalances), JSON.stringify(txi?.meta?.postTokenBalances));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
