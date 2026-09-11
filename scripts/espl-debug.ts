// Experiment: where does a delegated SPL balance show up on the ER, per flow and per validator?
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, MINT_SIZE, getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction, createInitializeMintInstruction, createMintToInstruction, getMinimumBalanceForRentExemptMint } from "@solana/spl-token";
import { delegateSpl, deriveEphemeralAta, deriveRentPda, deriveShuttleAta, deriveShuttleEphemeralAta, deriveShuttleWalletAta, getAuthToken, EPHEMERAL_SPL_TOKEN_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import * as nacl from "tweetnacl";

const TEE = "https://devnet-tee.magicblock.app";
const EU = "https://devnet-eu.magicblock.app";
const TEE_VALIDATOR = new PublicKey("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");
const EU_VALIDATOR = new PublicKey("MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fmt(info: any) {
  if (!info) return "null";
  const d: Buffer = info.data;
  const amt = d.length >= 72 ? d.readBigUInt64LE(64).toString() : "-";
  return `owner=${info.owner.toBase58().slice(0, 8)} len=${d.length} amount@64=${amt}`;
}
async function inspect(label: string, conn: Connection, keys: Record<string, PublicKey>) {
  for (const [name, k] of Object.entries(keys)) {
    try { console.log(`  ${label.padEnd(4)} ${name.padEnd(14)} ${k.toBase58().slice(0, 10)} ${fmt(await conn.getAccountInfo(k, "processed"))}`); }
    catch (e: any) { console.log(`  ${label.padEnd(4)} ${name.padEnd(14)} err ${String(e.message).slice(0, 60)}`); }
  }
}
async function main() {
  const payer = anchor.Wallet.local().payer;
  const l1 = new Connection("https://api.devnet.solana.com", "confirmed");
  const tok = await getAuthToken(TEE, payer.publicKey, (m: Uint8Array) => Promise.resolve(nacl.sign.detached(m, payer.secretKey)));
  const tee = new Connection(`${TEE}?token=${tok.token}`, "confirmed");
  const eu = new Connection(EU, "confirmed");
  const [rentPda] = deriveRentPda();

  // one mint, three users
  const mint = Keypair.generate();
  const users = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
  const atas = users.map((u) => getAssociatedTokenAddressSync(mint.publicKey, u.publicKey));
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: rentPda, lamports: 0.05 * LAMPORTS_PER_SOL }),
    SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey, space: MINT_SIZE, lamports: await getMinimumBalanceForRentExemptMint(l1), programId: TOKEN_PROGRAM_ID }),
    createInitializeMintInstruction(mint.publicKey, 6, payer.publicKey, null),
  );
  for (const [i, u] of users.entries()) tx.add(
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: u.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL }),
    createAssociatedTokenAccountInstruction(payer.publicKey, atas[i], u.publicKey, mint.publicKey),
    createMintToInstruction(mint.publicKey, atas[i], payer.publicKey, 1_000_000),
  );
  await sendAndConfirmTransaction(l1, tx, [payer, mint], { commitment: "confirmed" });
  console.log("mint", mint.publicKey.toBase58());

  const cases = [
    { name: "legacy->EU", user: users[0], ata: atas[0], idempotent: false, validator: EU_VALIDATOR, conn: eu, first: true },
    { name: "shuttle->TEE", user: users[1], ata: atas[1], idempotent: true, validator: TEE_VALIDATOR, conn: tee, first: false },
    { name: "shuttle->EU", user: users[2], ata: atas[2], idempotent: true, validator: EU_VALIDATOR, conn: eu, first: false },
  ];
  for (const c of cases) {
    console.log(`\n== ${c.name}`);
    try {
      const ixs = await delegateSpl(c.user.publicKey, mint.publicKey, 500_000n, { validator: c.validator, idempotent: c.idempotent as any, payer: payer.publicKey, initVaultIfMissing: c.first });
      let sig = "";
      for (let a = 0; ; a++) {
        try { sig = await sendAndConfirmTransaction(l1, new Transaction().add(...ixs), [payer, c.user], { commitment: "confirmed", skipPreflight: false }); break; }
        catch (e: any) { if (a < 3 && String(e.message).includes("Blockhash not found")) { await sleep(2000); continue; } throw e; }
      }
      console.log("  delegateSpl L1 sig", sig.slice(0, 20), "ixs:", ixs.length, ixs.map((i) => i.programId.toBase58().slice(0, 6)).join(","));
    } catch (e: any) { console.log("  delegateSpl failed:", String(e.message).slice(0, 300), (e.logs ?? []).slice(-6).join(" | ")); continue; }
    const [eata] = deriveEphemeralAta(c.user.publicKey, mint.publicKey);
    const keys: Record<string, PublicKey> = { ata: c.ata, eata };
    try { keys.shuttleAta = (deriveShuttleAta as any)(c.user.publicKey, mint.publicKey)[0]; } catch {}
    try { keys.shuttleEata = (deriveShuttleEphemeralAta as any)(c.user.publicKey, mint.publicKey)[0]; } catch {}
    try { keys.shuttleWallet = (deriveShuttleWalletAta as any)(c.user.publicKey, mint.publicKey)[0]; } catch {}
    for (let round = 0; round < 2; round++) {
      await sleep(round === 0 ? 2000 : 5000);
      console.log(`  -- after ${2 + round * 5}s`);
      await inspect("L1", l1, keys);
      await inspect("ER", c.conn, keys);
    }
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
