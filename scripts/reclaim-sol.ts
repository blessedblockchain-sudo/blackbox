/**
 * Send the leftover SOL of every generated wallet (e2e runs, round bots,
 * backers, house) back to the admin wallet on L1. Only wallet balances can be
 * reclaimed; rent held by program accounts stays where it is.
 *
 *   CLUSTER=devnet pnpm exec ts-node --transpile-only scripts/reclaim-sol.ts
 *   DRY_RUN=1 to only list balances.
 */
import { Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import * as anchor from "@coral-xyz/anchor";
import { BlackboxClient, Cluster } from "../packages/sdk/src";

const CLUSTER = (process.env.CLUSTER || "local") as Cluster;
const DRY_RUN = !!process.env.DRY_RUN;
const FEE = 5_000;

function wallets(): Keypair[] {
  const dir = path.join(__dirname, "../.mb");
  const secrets: number[][] = [];
  for (const f of fs.readdirSync(dir)) {
    if (f.startsWith(`e2e-keys-${CLUSTER}-`) && f.endsWith(".json")) secrets.push(...JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
  }
  const round = path.join(dir, `round-${CLUSTER}.json`);
  if (fs.existsSync(round)) {
    const st = JSON.parse(fs.readFileSync(round, "utf8"));
    for (const e of [...(st.entrants ?? []), ...(st.backers ?? []), ...(st.house ? [st.house] : [])]) if (e.secretKey) secrets.push(e.secretKey);
  }
  const seen = new Set<string>();
  return secrets.map((s) => Keypair.fromSecretKey(Uint8Array.from(s))).filter((k) => !seen.has(k.publicKey.toBase58()) && seen.add(k.publicKey.toBase58()));
}

async function main() {
  const admin = anchor.Wallet.local().payer;
  const conn = new BlackboxClient(admin, CLUSTER).base;
  let total = 0;
  for (const kp of wallets()) {
    const bal = await conn.getBalance(kp.publicKey);
    if (bal <= FEE) continue;
    total += bal - FEE;
    if (DRY_RUN) {
      console.log(`${kp.publicKey.toBase58()}  ${(bal / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
      continue;
    }
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: admin.publicKey, lamports: bal - FEE }));
    try {
      const sig = await sendAndConfirmTransaction(conn, tx, [kp], { commitment: "confirmed" });
      console.log(`${kp.publicKey.toBase58()}  +${((bal - FEE) / LAMPORTS_PER_SOL).toFixed(6)} SOL  ${sig.slice(0, 16)}`);
    } catch (e) {
      console.log(`${kp.publicKey.toBase58()}  skipped: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
    }
  }
  console.log(`${DRY_RUN ? "reclaimable" : "reclaimed"}: ${(total / LAMPORTS_PER_SOL).toFixed(6)} SOL to ${admin.publicKey.toBase58()}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
