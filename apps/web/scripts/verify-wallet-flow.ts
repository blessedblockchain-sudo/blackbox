#!/usr/bin/env ts-node
/**
 * Proves the browser path works on a live devnet round, from Node.
 *
 * It creates a throwaway keypair — the stand-in for a judge arriving with a
 * fresh browser wallet — and sends exactly the transactions `/back` sends,
 * built by exactly the same modules the page imports: `lib/faucet.ts` for the
 * test-USDC mint (co-signed by the committed faucet key), `lib/license-ix.ts`
 * and `lib/espl.ts` for open_license, delegate_license, the Ephemeral SPL
 * deposit, activate_license and schedule_license_tick. Then it signs the TEE
 * login challenge with that key and reads the licence back, and checks that the
 * same read without a token returns nothing.
 *
 *   pnpm exec ts-node --transpile-only apps/web/scripts/verify-wallet-flow.ts \
 *     [--margin 60] [--author <pubkey>] [--file .mb/round-devnet.json] \
 *     [--fund 0.3] [--no-record]
 *
 * `--no-record` skips writing the licence into the round file; without it the
 * licence is recorded the way the local server records one, so the round
 * runner settles it at the end (`close_round` refuses while a licence is open).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import nacl from "tweetnacl";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, type TransactionInstruction } from "@solana/web3.js";
import { ENDPOINTS } from "@blackbox/sdk/src/constants";
import { decodeAccount, entrantPda, licensePda, roundPda, toEntrantView, toLicenseView, toRoundView } from "../lib/chain";
import { DELEGATION_PROGRAM_ID, ata, depositSplIxs, ephemeralAta, tokenAmount } from "../lib/espl";
import { faucetAuthority, faucetKeypair, faucetMintIxs, FAUCET_AMOUNT } from "../lib/faucet";
import { activateLicenseIx, delegateLicenseIxs, openLicenseIxs, scheduleLicenseTickIx } from "../lib/license-ix";
import { getAuthToken, tokenUrl } from "../lib/tee-auth";
import { upsertLicenseRecord } from "../lib/server/round-file";

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const ROOT = path.join(__dirname, "../../..");
const FILE = flag("file", path.join(ROOT, ".mb/round-devnet.json"))!;
const MARGIN = BigInt(Math.round(Number(flag("margin", "60")) * 1e6));
const FUND_SOL = Number(flag("fund", "0.3"));
const RECORD = !args.includes("--no-record");

const EP = ENDPOINTS.devnet;
const base = new Connection(EP.base, { commitment: "confirmed" });
const teePublic = new Connection(EP.tee, { commitment: "confirmed" });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const usdc = (v: bigint) => `${(Number(v) / 1e6).toFixed(6)} USDC`;
const sigs: { step: string; layer: "l1" | "er"; sig: string }[] = [];

let t0 = Date.now();
function log(msg: string) {
  console.log(`[${String(Date.now() - t0).padStart(6)} ms] ${msg}`);
}

async function sendL1(payer: Keypair, ixs: TransactionInstruction[], step: string, extra: Keypair[] = []): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      const tx = new Transaction().add(...ixs);
      tx.feePayer = payer.publicKey;
      const bh = await base.getLatestBlockhash("confirmed");
      tx.recentBlockhash = bh.blockhash;
      tx.sign(payer, ...extra);
      const sig = await base.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 5 });
      const conf = await base.confirmTransaction({ signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }, "confirmed");
      if (conf.value.err) throw new Error(`${step}: ${JSON.stringify(conf.value.err)}`);
      sigs.push({ step, layer: "l1", sig });
      log(`${step} -> ${sig}`);
      return sig;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (attempt >= 3 || !/blockhash|429|Too Many|timed out|block height exceeded/i.test(msg)) throw new Error(`${step} failed: ${msg}`);
      log(`${step} retry ${attempt + 1}: ${msg.slice(0, 120)}`);
      await sleep(1500 * (attempt + 1));
    }
  }
}

async function sendEr(tee: Connection, payer: Keypair, ixs: TransactionInstruction[], step: string): Promise<string> {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await tee.getLatestBlockhash()).blockhash;
  tx.sign(payer);
  const sig = await tee.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const conf = await tee.confirmTransaction(sig, "confirmed");
  if (conf.value.err) {
    const logs = await tee.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }).catch(() => null);
    throw new Error(`${step} failed on the rollup: ${JSON.stringify(conf.value.err)}\n${(logs?.meta?.logMessages ?? []).join("\n")}`);
  }
  sigs.push({ step, layer: "er", sig });
  log(`${step} -> ${sig}`);
  return sig;
}

async function fund(visitor: PublicKey) {
  const want = Math.round(FUND_SOL * LAMPORTS_PER_SOL);
  try {
    const sig = await base.requestAirdrop(visitor, want);
    const bh = await base.getLatestBlockhash("confirmed");
    await base.confirmTransaction({ signature: sig, ...bh }, "confirmed");
    log(`airdropped ${FUND_SOL} SOL -> ${sig}`);
    return;
  } catch (e) {
    log(`airdrop refused (${String(e).slice(0, 80)}); falling back to a transfer from the local wallet`);
  }
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(process.env.HOME!, ".config/solana/id.json"), "utf8"))));
  await sendL1(admin, [SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: visitor, lamports: want })], `fund ${FUND_SOL} SOL`);
}

async function main() {
  const raw = JSON.parse(fs.readFileSync(FILE, "utf8")) as { round: string; roundId: number; mint: string; entrants: { name: string; owner: string }[] };
  const round = new PublicKey(raw.round);
  const mint = new PublicKey(raw.mint);
  console.log(`round #${raw.roundId} ${round.toBase58()} · mint ${mint.toBase58()}`);
  if (!roundPda(raw.roundId).equals(round)) throw new Error("round file's round address does not match its id");

  // The Round lives on the rollup while it runs; read it there.
  const roundInfo = await teePublic.getAccountInfo(round, "processed");
  if (!roundInfo) throw new Error("the Round account is not visible on the TEE endpoint");
  const view = toRoundView(decodeAccount("round", roundInfo.data));
  console.log(`status ${view.status} · tick ${view.tick}/${view.durationTicks} · margin ${view.minMargin}-${view.maxMargin} USDC · validator ${view.validator}`);
  if (view.status !== "live") throw new Error(`the round is ${view.status}; activation needs a live round`);
  if (Number(MARGIN) / 1e6 < view.minMargin) throw new Error(`margin below the round minimum of ${view.minMargin} USDC`);

  // Pick the author with the highest blind price, the way the /back table sorts.
  const owners = raw.entrants.map((e) => e.owner);
  const entrants = await teePublic.getMultipleAccountsInfo(owners.map((o) => entrantPda(round, new PublicKey(o))), "processed");
  const rows = entrants
    .map((acc, i) => (acc ? { ...toEntrantView(decodeAccount("entrant", acc.data)), name: raw.entrants[i].name } : null))
    .filter((x): x is NonNullable<typeof x> => !!x && !x.settled && x.licenseCount < 8);
  if (!rows.length) throw new Error("no backable entrant in this round");
  rows.sort((a, b) => b.feePriceBps - a.feePriceBps);
  const chosen = flag("author") ? rows.find((r) => r.owner === flag("author"))! : rows[0];
  const author = new PublicKey(chosen.owner);
  console.log(`backing ${chosen.name} ${chosen.owner} at ${chosen.feePriceBps} bps (${chosen.licenseCount} licences so far)`);

  // --read-only re-reads the licence of a visitor from an earlier run instead of opening another one.
  const readOnly = args.includes("--read-only");
  const keyFile = flag("visitor", path.join(ROOT, ".mb/web-visitor.json"))!;
  const visitor = readOnly ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keyFile, "utf8")))) : Keypair.generate();
  console.log(`\n${readOnly ? "visitor wallet" : "throwaway visitor wallet"} ${visitor.publicKey.toBase58()}`);
  if (!readOnly) fs.writeFileSync(keyFile, JSON.stringify(Array.from(visitor.secretKey)));

  t0 = Date.now();
  if (!readOnly) await fund(visitor.publicKey);

  // 1) the faucet button: the visitor pays, the committed faucet key co-signs mint_to.
  log(`faucet authority ${faucetAuthority().toBase58()}`);
  if (!readOnly) await sendL1(visitor, faucetMintIxs(mint, visitor.publicKey), "faucet mint 1,000 test USDC", [faucetKeypair()]);
  const minted = tokenAmount((await base.getAccountInfo(ata(mint, visitor.publicKey), "confirmed"))?.data) ?? 0n;
  log(`wallet now holds ${usdc(minted)} on L1`);
  if (!readOnly && minted !== FAUCET_AMOUNT) throw new Error(`expected ${usdc(FAUCET_AMOUNT)}, got ${usdc(minted)}`);

  // 2) the TEE session the page's "Sign in to TEE" button creates.
  const { token } = await getAuthToken(EP.tee, visitor.publicKey.toBase58(), async (m) => nacl.sign.detached(m, visitor.secretKey));
  const tee = new Connection(tokenUrl(EP.tee, token), { commitment: "confirmed" });
  log(`TEE auth token …${token.slice(-6)}`);

  // 3) the five transactions of the back flow.
  const license = licensePda(round, visitor.publicKey, author);
  if (!readOnly) {
  await sendL1(visitor, openLicenseIxs(round, mint, visitor.publicKey, author), "open_license");
  await sendL1(visitor, delegateLicenseIxs(round, visitor.publicKey, author, new PublicKey(view.validator)), "delegate_license");
  await sendL1(visitor, depositSplIxs(visitor.publicKey, mint, minted, new PublicKey(view.validator)), `deposit ${usdc(minted)} into the rollup`);

  const erBalance = async (): Promise<bigint> => {
    const eata = await base.getAccountInfo(ephemeralAta(visitor.publicKey, mint), "confirmed");
    if (!eata?.owner.equals(DELEGATION_PROGRAM_ID)) return -1n;
    return tokenAmount((await tee.getAccountInfo(ata(mint, visitor.publicKey), "processed"))?.data) ?? 0n;
  };
  const waitStart = Date.now();
  for (;;) {
    const b = await erBalance();
    if (b >= MARGIN) {
      log(`rollup balance ${usdc(b)}`);
      break;
    }
    if (Date.now() - waitStart > 60_000) throw new Error(`rollup balance stuck at ${b < 0n ? "no account" : usdc(b)}`);
    await sleep(1000);
  }
  for (let i = 0; ; i++) {
    if (await tee.getAccountInfo(license, "processed").catch(() => null)) break;
    if (i > 45) throw new Error("the License never appeared on the rollup");
    await sleep(1000);
  }
  log("License visible on the rollup");

  await sendEr(tee, visitor, [activateLicenseIx(round, mint, visitor.publicKey, author, MARGIN)], `activate_license with ${usdc(MARGIN)}`);
  const taskId = 5_000_000_000 + Math.floor(Math.random() * 1_000_000_000);
  await sendEr(tee, visitor, [scheduleLicenseTickIx(round, visitor.publicKey, author, view.markets.map((m) => new PublicKey(m.feed)), taskId, visitor.publicKey)], `schedule_license_tick (task ${taskId})`);
  }

  // 4) record it the way the local server does, so the runner settles it at round end.
  if (RECORD && !readOnly) {
    try {
      await upsertLicenseRecord(FILE, raw.round, { name: "WebVisitor", buyer: visitor.publicKey.toBase58(), author: author.toBase58(), bot: false, scheduled: true, source: "verify-wallet-flow" });
      log("recorded in the round file, so the runner settles it with the rest");
    } catch (e) {
      log(`could not record the licence: ${String(e).slice(0, 160)} — settle it by hand before close_round`);
    }
  }

  // 5) read it back the way the licence panel does, and check the control read.
  console.log("");
  for (let i = 0; i < 40; i++) {
    const mine = await tee.getAccountInfo(license, "processed");
    if (!mine) throw new Error("the TEE returned nothing for the licence even with the owner token");
    const l = toLicenseView(decodeAccount("license", mine.data));
    if (i === 0 || l.tradeCount > 0 || i === 39) {
      console.log(
        `licence ${license.toBase58()}\n  active=${l.active} margin=${l.margin} equity=${l.lastEquity} fees=${l.accruedFees} trades=${l.tradeCount} feeBps=${l.feeBps} lastTick=${l.lastTick} legs=${JSON.stringify(l.legs)}`,
      );
      if (l.tradeCount > 0) break;
    }
    await sleep(3000);
  }
  const stranger = await teePublic.getAccountInfo(license, "processed");
  console.log(`\ncontrol: the same read with no token returned ${stranger ? `${stranger.data.length} bytes — LEAK` : "null"}`);
  const strategy = await teePublic.getAccountInfo(new PublicKey(chosen.owner), "processed");
  void strategy;

  console.log("\n--- signatures ---");
  for (const s of sigs) {
    const url = s.layer === "l1" ? `https://explorer.solana.com/tx/${s.sig}?cluster=devnet` : `https://explorer.solana.com/tx/${s.sig}?cluster=custom&customUrl=${encodeURIComponent(EP.tee)}`;
    console.log(`${s.layer.toUpperCase().padEnd(2)} ${s.step}\n   ${s.sig}\n   ${url}`);
  }
  console.log(`\nvisitor ${visitor.publicKey.toBase58()} · licence ${license.toBase58()} · author ${author.toBase58()}`);
  console.log(`SOL left: ${((await base.getBalance(visitor.publicKey, "confirmed")) / LAMPORTS_PER_SOL).toFixed(6)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
