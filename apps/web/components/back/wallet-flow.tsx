"use client";
/**
 * Blind licensing from a browser wallet on devnet.
 *
 * Five transactions, all signed by the visitor's wallet: open_license and
 * delegate_license on Solana L1, an Ephemeral SPL deposit that moves the test
 * USDC into the rollup, then activate_license and schedule_license_tick sent to
 * the TEE endpoint with the wallet's own auth token (lib/tee-auth.ts).
 *
 * The one hard constraint: a wallet can deposit into the rollup only once per
 * round — a second `delegateSpl` fails because the ephemeral ATA is already
 * delegated — so the first deposit moves the wallet's whole test-USDC balance
 * in and later licences draw on it.
 */
import { useEffect, useState, type FormEvent } from "react";
import { Connection, PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import type { BackJob, JobStep, PublicRoundInfo, StepLayer } from "../../lib/api-types";
import { PROGRAM_ID, decodeAccount, licensePda, toLicenseView, type RoundView } from "../../lib/chain";
import { activateLicenseIx, delegateLicenseIxs, openLicenseIxs, scheduleLicenseTickIx } from "../../lib/license-ix";
import { DELEGATION_PROGRAM_ID, ata, depositSplIxs, ephemeralAta, tokenAmount } from "../../lib/espl";
import { checkRange, formatSol, formatUsdcAmount, parseUsdcInput } from "../../lib/amount";
import { baseTxExplorer, erTxExplorer } from "../../lib/explorer";
import { formatBps, shortAddr } from "../../lib/format";
import { tokenUrl } from "../../lib/tee-auth";
import { identityOwner, identityToken, useSharedIdentity } from "../../lib/wallet-identity";
import { SOL_NEEDED } from "../try/try-live";
import { WalletPicker } from "../studio/identity";
import { Button } from "../ui";
import type { AuthorRow } from "./author-table";
import { JobPanel } from "./job-steps";

const STEPS: [string, string, StepLayer][] = [
  ["funds", "Check your wallet: SOL and the round's test USDC", "l1"],
  ["open", "open_license: your License and its custody accounts", "l1"],
  ["delegate", "delegate_license: hand the License to the TEE validator", "l1"],
  ["deposit", "Move your test USDC into the rollup (Ephemeral SPL)", "l1"],
  ["erBalance", "Wait for the deposit to land on the rollup", "wait"],
  ["erLicense", "Wait for the License to appear on the rollup", "wait"],
  ["activate", "activate_license: private to you and the author, margin in, fee locked", "er"],
  ["schedule", "schedule_license_tick: the crank runs the author's code on your book", "er"],
];

/** Rent and fees for open_license + delegate_license + the deposit: 0.0141 SOL measured on devnet. */
const SOL_FOR_LICENSE = 0.016;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const usdc = (micro: bigint) => formatUsdcAmount(Number(micro) / 1e6);

export function WalletBackFlow({ info, round, author, block, lock }: { info: PublicRoundInfo; round: RoundView | null; author: AuthorRow; block: string | null; lock: number | null }) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [identity, setIdentity] = useSharedIdentity();
  const owner = identityOwner(identity);
  const token = identityToken(identity);
  const [deployed, setDeployed] = useState<boolean | null>(null);
  const [margin, setMargin] = useState("100");
  const [touched, setTouched] = useState(false);
  const [job, setJob] = useState<BackJob | null>(null);

  useEffect(() => {
    let stop = false;
    connection
      .getAccountInfo(PROGRAM_ID, "confirmed")
      .then((i) => !stop && setDeployed(!!i?.executable))
      .catch(() => !stop && setDeployed(null));
    return () => {
      stop = true;
    };
  }, [connection]);

  const parsed = parseUsdcInput(margin);
  const rangeError = parsed.ok && round ? checkRange(parsed.micro, round.minMargin, round.maxMargin) : null;
  const fieldError = !parsed.ok ? parsed.error : rangeError;
  const running = job?.status === "running";
  const reason =
    block ??
    (deployed === false
      ? "The BLACKBOX program is not deployed on this cluster yet, so these transactions would fail."
      : !owner
        ? "Connect a wallet first."
        : !token
          ? "Sign in to the TEE first: the rollup transactions and your License reads use your auth token."
          : !wallet.signTransaction || !wallet.sendTransaction
            ? "This wallet cannot sign transactions."
            : running
              ? "Setting up your licence."
              : null);

  const run = async (marginMicro: bigint) => {
    if (!owner || !token || !round || !info.round || !wallet.signTransaction) return;
    const me = new PublicKey(owner);
    const r = new PublicKey(info.round);
    const mint = new PublicKey(round.mint);
    const authorKey = new PublicKey(author.owner);
    const validator = new PublicKey(round.validator);
    const license = licensePda(r, me, authorKey);
    const tee = new Connection(tokenUrl(info.endpoints.tee, token), { commitment: "confirmed" });
    const j: BackJob = {
      id: String(Date.now()),
      round: info.round,
      buyer: owner,
      author: author.owner,
      authorName: author.name,
      margin: Number(marginMicro) / 1e6,
      status: "running",
      startedAt: Date.now(),
      finishedAt: null,
      error: null,
      steps: STEPS.map(([key, label, layer]): JobStep => ({ key, label, layer, status: "pending" })),
    };
    const commit = () => setJob({ ...j, steps: j.steps.map((s) => ({ ...s })) });
    commit();

    const step = async (key: string, fn: () => Promise<{ sig?: string; detail?: string; skipped?: boolean } | void>) => {
      const s = j.steps.find((x) => x.key === key)!;
      s.status = "running";
      commit();
      const t0 = Date.now();
      try {
        const res = (await fn()) || {};
        s.ms = Date.now() - t0;
        if (res.sig) {
          s.sig = res.sig;
          s.explorer = s.layer === "er" ? erTxExplorer(res.sig, info.cluster, info.endpoints.tee) : baseTxExplorer(res.sig, info.cluster);
        }
        if (res.detail) s.detail = res.detail;
        s.status = res.skipped ? "skipped" : "done";
      } catch (e) {
        s.ms = Date.now() - t0;
        s.status = "error";
        s.detail = e instanceof Error ? e.message : String(e);
        throw e;
      } finally {
        commit();
      }
    };

    const sendL1 = async (ixs: TransactionInstruction[]) => {
      const tx = new Transaction().add(...ixs);
      tx.feePayer = me;
      const bh = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = bh.blockhash;
      const sig = await wallet.sendTransaction(tx, connection);
      const conf = await connection.confirmTransaction({ signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }, "confirmed");
      if (conf.value.err) throw new Error(`transaction failed on Solana: ${JSON.stringify(conf.value.err)} (${sig})`);
      return sig;
    };
    const sendEr = async (ixs: TransactionInstruction[]) => {
      const tx = new Transaction().add(...ixs);
      tx.feePayer = me;
      tx.recentBlockhash = (await tee.getLatestBlockhash()).blockhash;
      const signed = await wallet.signTransaction!(tx);
      const sig = await tee.sendRawTransaction(signed.serialize(), { skipPreflight: true });
      const conf = await tee.confirmTransaction(sig, "confirmed");
      if (conf.value.err) throw new Error(`transaction failed on the rollup: ${JSON.stringify(conf.value.err)} (${sig})`);
      return sig;
    };
    const erBalance = async (): Promise<bigint> => {
      // Read the rollup balance only once the ephemeral ATA is delegated (see BlackboxClient.hasErDeposit):
      // an earlier read makes the ER clone the ATA as a plain account that later writes reject.
      const eata = await connection.getAccountInfo(ephemeralAta(me, mint), "confirmed");
      if (!eata?.owner.equals(DELEGATION_PROGRAM_ID)) return -1n;
      return tokenAmount((await tee.getAccountInfo(ata(mint, me), "processed"))?.data) ?? 0n;
    };

    try {
      let deposit = 0n;
      await step("funds", async () => {
        const [sol, usdcInfo, er] = await Promise.all([connection.getBalance(me, "confirmed"), connection.getAccountInfo(ata(mint, me), "confirmed"), erBalance()]);
        const l1 = tokenAmount(usdcInfo?.data) ?? 0n;
        if (sol < SOL_FOR_LICENSE * 1e9)
          throw new Error(
            `Your wallet holds ${formatSol(sol / 1e9)} SOL on ${info.cluster} and this needs about ${SOL_FOR_LICENSE} for the licence accounts' rent and fees (about ${SOL_NEEDED} for the whole path). Devnet SOL is free at faucet.solana.com.`,
          );
        if (er >= marginMicro) return { detail: `${usdc(er)} USDC already on the rollup, no deposit needed` };
        if (er >= 0n)
          throw new Error(
            `You have ${usdc(er)} USDC inside the rollup and a wallet can deposit only once per round (the second Ephemeral SPL delegate fails on the already-delegated account). Back with at most ${usdc(er)} USDC, or use another wallet.`,
          );
        if (l1 < marginMicro)
          throw new Error(
            `Your wallet holds ${usdc(l1)} of the round's test USDC (mint ${shortAddr(mint.toBase58())}) and the margin needs ${usdc(marginMicro)}. Use "Get test USDC" in the Try it live panel; it is a test mint, not Circle USDC.`,
          );
        // One deposit per wallet per round, so move the whole balance in: later licences draw on it.
        deposit = l1;
        return { detail: `${formatSol(sol / 1e9)} SOL · ${usdc(l1)} test USDC` };
      });
      await step("open", async () => {
        if (await connection.getAccountInfo(license, "confirmed")) return { skipped: true, detail: "this License already exists" };
        return { sig: await sendL1(openLicenseIxs(r, mint, me, authorKey)) };
      });
      await step("delegate", async () => {
        const l1 = await connection.getAccountInfo(license, "confirmed");
        if (l1?.owner.equals(DELEGATION_PROGRAM_ID)) return { skipped: true, detail: "already delegated" };
        return { sig: await sendL1(delegateLicenseIxs(r, me, authorKey, validator)) };
      });
      await step("deposit", async () => {
        if (deposit === 0n) return { skipped: true, detail: "your rollup balance already covers the margin" };
        return { sig: await sendL1(depositSplIxs(me, mint, deposit, validator)), detail: `${usdc(deposit)} USDC — your whole balance, because a wallet deposits once per round` };
      });
      await step("erBalance", async () => {
        const t0 = Date.now();
        for (;;) {
          const b = await erBalance();
          if (b >= marginMicro) return { detail: `${usdc(b)} USDC spendable on the rollup` };
          if (Date.now() - t0 > 60_000) throw new Error(`the rollup balance is stuck at ${b < 0n ? "no account" : usdc(b)} after 60 s`);
          await sleep(1000);
        }
      });
      await step("erLicense", async () => {
        const t0 = Date.now();
        for (;;) {
          if (await tee.getAccountInfo(license, "processed").catch(() => null)) return { detail: "visible to your TEE token" };
          if (Date.now() - t0 > 45_000) throw new Error("the License did not appear on the rollup within 45 s");
          await sleep(1000);
        }
      });
      await step("activate", async () => {
        const cur = await tee.getAccountInfo(license, "processed");
        if (cur && toLicenseView(decodeAccount("license", cur.data)).active) return { skipped: true, detail: "already active" };
        return { sig: await sendEr([activateLicenseIx(r, mint, me, authorKey, marginMicro)]), detail: `fee locked at ${formatBps(lock, { decimals: 0 })} of traded notional` };
      });
      await step("schedule", async () => {
        const taskId = 5_000_000_000 + Math.floor(Math.random() * 1_000_000_000);
        const feeds = round.markets.map((m) => new PublicKey(m.feed));
        try {
          return { sig: await sendEr([scheduleLicenseTickIx(r, me, authorKey, feeds, taskId, me)]), detail: `task ${taskId}, paid by your wallet on the rollup` };
        } catch (e) {
          throw new Error(
            `${e instanceof Error ? e.message : String(e)}\nThe licence is active and holds your margin, but has no crank task, so it will not trade. schedule_license_tick takes any payer, so it can be retried — press the button again.`,
          );
        }
      });
      j.status = "done";
    } catch (e) {
      j.status = "error";
      j.error = e instanceof Error ? e.message : String(e);
    } finally {
      j.finishedAt = Date.now();
      commit();
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (fieldError || reason || !parsed.ok) return;
    void run(parsed.micro);
  };

  const invalid = touched && !!fieldError;
  return (
    <div className="space-y-3 border-t border-edge px-3 py-3">
      {deployed === false ? (
        <p className="border border-warn/30 bg-warn-deep px-3 py-2 text-xs text-warn">
          getAccountInfo({shortAddr(PROGRAM_ID.toBase58())}) returned no executable program on {info.cluster}: the BLACKBOX program is not deployed there yet. The flow below is what this page sends once it
          is.
        </p>
      ) : null}
      <WalletPicker info={info} identity={identity} onChange={setIdentity} />
      <form onSubmit={submit} noValidate className="space-y-2">
        <div>
          <label htmlFor="wallet-margin" className="label-caps">
            Margin (USDC)
          </label>
          <input
            id="wallet-margin"
            name="margin"
            type="text"
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            value={margin}
            onChange={(e) => setMargin(e.target.value)}
            onBlur={() => setTouched(true)}
            aria-invalid={invalid}
            aria-describedby={`wallet-margin-help${invalid ? " wallet-margin-error" : ""}`}
            className="num mt-1 block min-h-9 w-36 border border-edge-strong bg-void px-2 text-[15px] text-fg outline-none focus-visible:border-gain/60 aria-[invalid=true]:border-loss/60"
          />
          <p id="wallet-margin-help" className="mt-1 text-xs text-fg-dim">
            {round ? `Between ${formatUsdcAmount(round.minMargin)} and ${formatUsdcAmount(round.maxMargin)} USDC of the round's test mint, from your wallet.` : "Waiting for the round."}
          </p>
          {invalid ? (
            <p id="wallet-margin-error" role="alert" className="mt-1 text-xs text-loss">
              {fieldError}
            </p>
          ) : null}
        </div>
        <Button variant="primary" type="submit" disabled={!!reason}>
          {running ? "Waiting for your wallet…" : `Back ${author.name}`}
        </Button>
        {reason ? <p className="text-xs text-fg-dim">{reason}</p> : null}
      </form>
      <ul className="list-disc space-y-1 pl-4 text-[11px] leading-4 text-fg-dim">
        <li>Your wallet signs three transactions on Solana (open_license, delegate_license, the USDC deposit) and two on the rollup (activate_license, schedule_license_tick), which go to the TEE endpoint with your auth token. Expect five wallet prompts.</li>
        <li>A wallet can deposit into the rollup only once per round, so the first deposit moves your whole test-USDC balance in; every licence you open afterwards spends from that balance.</li>
        <li>Your margin comes back when the licence settles, minus the fees the author earned on the notional your book traded — and minus whatever the strategy lost.</li>
      </ul>
      {job ? <JobPanel job={job} /> : null}
    </div>
  );
}
