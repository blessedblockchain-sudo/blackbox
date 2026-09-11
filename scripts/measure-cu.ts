/**
 * Compute units of tick_entrant / tick_license on the live round in
 * .mb/round-<cluster>.json. The Native Crank runs each scheduled instruction
 * with the default 200k CU budget, so this is the headroom check.
 *
 * Each tick runs once per round tick (a replay returns early and is cheap), so
 * the script simulates every instruction SAMPLE times at random offsets within
 * the tick interval and reports the maximum, which is the full-path cost.
 * Simulations are signed by the account's owner: the TEE serves private
 * accounts only to members.
 *
 *   CLUSTER=local pnpm exec ts-node --transpile-only scripts/measure-cu.ts
 */
import { ComputeBudgetProgram, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import * as anchor from "@coral-xyz/anchor";
import { BlackboxClient, pda, Cluster } from "../packages/sdk/src";

const CLUSTER = (process.env.CLUSTER || "local") as Cluster;
const SAMPLE = Number(process.env.SAMPLE || 12);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const st = JSON.parse(fs.readFileSync(path.join(__dirname, `../.mb/round-${CLUSTER}.json`), "utf8"));
  const bx = new BlackboxClient(anchor.Wallet.local().payer, CLUSTER);
  const round = new PublicKey(st.round);
  const rem = await bx.marketRemaining(round, st.feeds.map((f: string) => new PublicKey(f)));
  const tickMs = Number(st.tickMs || 400);

  const measure = async (label: string, kp: Keypair, ix: TransactionInstruction) => {
    const conn = await bx.tee(kp);
    const cus: number[] = [];
    let err = "";
    for (let i = 0; i < SAMPLE; i++) {
      const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ix);
      tx.feePayer = kp.publicKey;
      tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
      tx.sign(kp);
      const r = await conn.simulateTransaction(tx);
      if (r.value.err) err = JSON.stringify(r.value.err);
      else if (r.value.unitsConsumed) cus.push(r.value.unitsConsumed);
      await sleep(Math.random() * tickMs);
    }
    if (!cus.length) return console.log(`${label.padEnd(30)} no successful simulation${err ? ` (${err})` : ""}`);
    cus.sort((a, b) => a - b);
    const max = cus[cus.length - 1];
    console.log(`${label.padEnd(30)} min ${String(cus[0]).padStart(6)}  max ${String(max).padStart(6)} CU  (${((max / 200_000) * 100).toFixed(0)}% of 200k)`);
  };

  for (const e of st.entrants ?? []) {
    const kp = Keypair.fromSecretKey(Uint8Array.from(e.secretKey));
    const o = kp.publicKey;
    const ix = await bx.program.methods
      .tickEntrant()
      .accountsPartial({ round, scoreboard: pda.scoreboardPda(round), entrant: pda.entrantPda(round, o), strategy: pda.strategyPda(round, o), position: pda.positionPda(round, o) })
      .remainingAccounts(rem)
      .instruction();
    await measure(`tick_entrant ${e.name}`, kp, ix);
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
    await measure(`tick_license ${l.name ?? l.buyer.slice(0, 6)}`, kp, ix);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
