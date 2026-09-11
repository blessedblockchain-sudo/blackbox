/**
 * Simulate tick_entrant for each bot (and tick_license for each runner-owned
 * license) against the live round in .mb/round-<cluster>.json and print the
 * compute units used: the Native Crank runs each scheduled instruction with
 * the default 200k CU budget, so this is the headroom check.
 *
 *   CLUSTER=local pnpm exec ts-node --transpile-only scripts/measure-cu.ts
 */
import { ComputeBudgetProgram, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import * as anchor from "@coral-xyz/anchor";
import { BlackboxClient, pda, Cluster } from "../packages/sdk/src";

const CLUSTER = (process.env.CLUSTER || "local") as Cluster;

async function main() {
  const st = JSON.parse(fs.readFileSync(path.join(__dirname, `../.mb/round-${CLUSTER}.json`), "utf8"));
  const bx = new BlackboxClient(anchor.Wallet.local().payer, CLUSTER);
  const round = new PublicKey(st.round);
  const feeds = st.feeds.map((f: string) => new PublicKey(f));
  const rem = await bx.marketRemaining(round, feeds);

  // Simulate as the account's owner: the TEE only serves private accounts to members.
  const simulate = async (label: string, kp: Keypair, ix: TransactionInstruction) => {
    const conn = await bx.tee(kp);
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ix);
    tx.feePayer = kp.publicKey;
    tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
    tx.sign(kp);
    const r = await conn.simulateTransaction(tx);
    const cu = r.value.unitsConsumed ?? 0;
    console.log(`${label.padEnd(34)} ${r.value.err ? `ERR ${JSON.stringify(r.value.err)}` : "ok "} ${String(cu).padStart(7)} CU  (${((cu / 200_000) * 100).toFixed(0)}% of 200k)`);
    if (r.value.err) console.log((r.value.logs ?? []).slice(-6).map((l) => `    ${l}`).join("\n"));
  };

  for (const e of st.entrants ?? []) {
    const kp = Keypair.fromSecretKey(Uint8Array.from(e.secretKey));
    const owner = kp.publicKey;
    const ix = await bx.program.methods
      .tickEntrant()
      .accountsPartial({ round, scoreboard: pda.scoreboardPda(round), entrant: pda.entrantPda(round, owner), strategy: pda.strategyPda(round, owner), position: pda.positionPda(round, owner) })
      .remainingAccounts(rem)
      .instruction();
    await simulate(`tick_entrant ${e.name}`, kp, ix);
  }
  const backers = new Map<string, number[]>((st.backers ?? []).map((b: any) => [b.owner, b.secretKey]));
  for (const l of st.licenses ?? []) {
    const secret = backers.get(l.buyer);
    if (!secret) continue;
    const kp = Keypair.fromSecretKey(Uint8Array.from(secret));
    const author = new PublicKey(l.author);
    const ix = await bx.program.methods
      .tickLicense()
      .accountsPartial({ round, authorEntrant: pda.entrantPda(round, author), strategy: pda.strategyPda(round, author), license: pda.licensePda(round, kp.publicKey, author) })
      .remainingAccounts(rem)
      .instruction();
    await simulate(`tick_license ${l.name ?? l.buyer.slice(0, 6)}`, kp, ix);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
