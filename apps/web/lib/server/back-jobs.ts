/**
 * Blind-licensing jobs for the local web backer. A job runs the same sequence
 * as `backStrategy` in scripts/run-round.ts, one visible step at a time, and
 * records every transaction for the UI:
 *
 *   L1  open_license, delegate_license, deposit (Ephemeral SPL)
 *   ER  activate_license (private to [buyer, author]), schedule_license_tick (payer = admin)
 *
 * Right after open_license the license is appended to the round file's
 * `licenses`, so the runner settles it at round end even if a later step fails.
 * Jobs live in memory (one at a time); the browser polls GET /api/local/back.
 */
import { randomUUID } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { BLACKBOX_PROGRAM_ID, pda } from "@blackbox/sdk";
import { DELEGATION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import type { BackJob, JobStep, StepLayer } from "../api-types";
import { toLicenseView } from "../chain";
import { baseTxExplorer, erTxExplorer } from "../explorer";
import { formatBps } from "../format";
import { formatUsdcAmount } from "../amount";
import { clientFor, errorMessage } from "./local";
import { upsertLicenseRecord } from "./round-file";
import { BACKER_NAME, FIRST_DEPOSIT, ensureSol, ensureUsdc, loadAdmin, loadOrCreateBacker } from "./backer";

export interface BackPlan {
  file: string;
  round: PublicKey;
  mint: PublicKey;
  feeds: PublicKey[];
  author: PublicKey;
  authorName: string;
  /** 6-dp units. */
  margin: bigint;
  /** 6-dp units to deposit into the rollup (0 when the rollup balance covers the margin). */
  deposit: bigint;
}

const STEPS: [string, string, StepLayer][] = [
  ["sol", "Fund the backer with SOL", "l1"],
  ["usdc", "Mint test USDC to the backer", "l1"],
  ["open", "open_license: License + custody accounts", "l1"],
  ["record", "List the license in the round file", "local"],
  ["delegate", "delegate_license: hand the License to the TEE validator", "l1"],
  ["deposit", "Deposit USDC into the rollup (Ephemeral SPL)", "l1"],
  ["erBalance", "Wait for the deposit on the rollup", "wait"],
  ["erLicense", "Wait for the License on the rollup", "wait"],
  ["activate", "activate_license: private to you and the author, margin in, fee locked", "er"],
  ["schedule", "schedule_license_tick: the crank runs the author's code on your book", "er"],
];

const g = globalThis as unknown as { __bxBackJobs?: Map<string, BackJob> };
const jobs = () => (g.__bxBackJobs ??= new Map());

export function listJobs(round?: string, limit = 5): BackJob[] {
  return [...jobs().values()]
    .filter((j) => !round || j.round === round)
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, limit);
}

export function runningJob(): BackJob | null {
  return [...jobs().values()].find((j) => j.status === "running") ?? null;
}

const usdc = (micro: bigint) => formatUsdcAmount(Number(micro) / 1e6);

export function startBackJob(plan: BackPlan): BackJob {
  const { kp } = loadOrCreateBacker();
  const job: BackJob = {
    id: randomUUID().slice(0, 8),
    round: plan.round.toBase58(),
    buyer: kp.publicKey.toBase58(),
    author: plan.author.toBase58(),
    authorName: plan.authorName,
    margin: Number(plan.margin) / 1e6,
    status: "running",
    startedAt: Date.now(),
    finishedAt: null,
    error: null,
    steps: STEPS.map(([key, label, layer]): JobStep => ({ key, label, layer, status: "pending" })),
  };
  jobs().set(job.id, job);
  // Keep the last few jobs only.
  for (const old of listJobs(undefined, 100).slice(12)) jobs().delete(old.id);
  void run(job, plan);
  return job;
}

type StepResult = { sig?: string; detail?: string; skipped?: boolean } | void;

async function run(job: BackJob, plan: BackPlan) {
  const baseRpc = process.env.NEXT_PUBLIC_BASE_RPC;
  const teeRpc = process.env.NEXT_PUBLIC_TEE_RPC;
  const step = async (key: string, fn: () => Promise<StepResult>) => {
    const s = job.steps.find((x) => x.key === key)!;
    s.status = "running";
    const t0 = Date.now();
    try {
      const r = (await fn()) || {};
      s.ms = Date.now() - t0;
      if (r.sig) {
        s.sig = r.sig;
        s.explorer = s.layer === "er" ? erTxExplorer(r.sig, "local", teeRpc) : baseTxExplorer(r.sig, "local", baseRpc);
      }
      if (r.detail) s.detail = r.detail;
      s.status = r.skipped ? "skipped" : "done";
    } catch (e) {
      s.ms = Date.now() - t0;
      s.status = "error";
      s.detail = errorMessage(e);
      throw e;
    }
  };

  try {
    const { kp: backer } = loadOrCreateBacker();
    const admin = loadAdmin();
    const bx = clientFor(backer);
    const { round, mint, author } = plan;
    const lic = pda.licensePda(round, backer.publicKey, author);

    await step("sol", async () => {
      const r = await ensureSol(bx, backer.publicKey, admin);
      return r ? { sig: r.sig, detail: r.how } : { skipped: true, detail: "the backer already holds SOL" };
    });

    await step("usdc", async () => {
      if (plan.deposit === 0n) return { skipped: true, detail: "the rollup balance already covers the margin" };
      const r = await ensureUsdc(bx, backer.publicKey, admin, mint, plan.deposit);
      return r ? { sig: r.sig, detail: `minted ${usdc(r.minted)} test USDC` } : { skipped: true, detail: "L1 balance already covers the deposit" };
    });

    await step("open", async () => {
      if (await bx.base.getAccountInfo(lic, "confirmed")) return { skipped: true, detail: "License already exists" };
      return { sig: await bx.openLicense(round, mint, backer, author) };
    });

    await step("record", async () => {
      const added = await upsertLicenseRecord(plan.file, round.toBase58(), {
        name: BACKER_NAME,
        buyer: backer.publicKey.toBase58(),
        author: author.toBase58(),
        bot: false,
        source: "web",
      });
      return { detail: added ? "appended to licenses in .mb/round-local.json" : "already listed" };
    });

    await step("delegate", async () => {
      const info = await bx.base.getAccountInfo(lic, "confirmed");
      if (info?.owner.equals(DELEGATION_PROGRAM_ID)) return { skipped: true, detail: "already delegated" };
      if (!info?.owner.equals(BLACKBOX_PROGRAM_ID)) throw new Error(`License ${lic.toBase58()} is not owned by the program on L1`);
      return { sig: await bx.delegateLicense(round, backer, author) };
    });

    await step("deposit", async () => {
      if (plan.deposit === 0n) return { skipped: true, detail: "rollup balance covers the margin" };
      return { sig: await bx.depositToEr(backer, mint, plan.deposit), detail: `${usdc(plan.deposit)} USDC` };
    });

    await step("erBalance", async () => {
      const bal = await bx.waitErBalance(backer, mint, plan.margin);
      return { detail: `${usdc(bal)} USDC spendable on the rollup` };
    });

    await step("erLicense", async () => {
      await bx.waitOnEr(backer, lic);
      return { detail: "visible to your TEE token" };
    });

    await step("activate", async () => {
      const cur = await bx.fetchLicense(round, backer, backer.publicKey, author).catch(() => null);
      if (cur && toLicenseView(cur).active) return { skipped: true, detail: "already active" };
      const sig = await bx.activateLicense(round, mint, backer, author, plan.margin);
      const after = await bx.fetchLicense(round, backer, backer.publicKey, author).catch(() => null);
      const v = after ? toLicenseView(after) : null;
      return { sig, detail: v ? `margin ${formatUsdcAmount(v.margin)} USDC · fee ${formatBps(v.feeBps, { decimals: 0 })} locked` : undefined };
    });

    await step("schedule", async () => {
      const taskId = 5_000_000_000 + Math.floor(Math.random() * 1_000_000_000);
      try {
        const sig = await bx.scheduleLicenseTick(round, backer.publicKey, author, plan.feeds, taskId, admin);
        await upsertLicenseRecord(plan.file, round.toBase58(), { buyer: backer.publicKey.toBase58(), author: author.toBase58(), scheduled: true });
        return { sig, detail: `task ${taskId}, paid by the admin` };
      } catch (e) {
        // The license is active; hand the crank task to the round runner (it schedules `scheduled: false`).
        await upsertLicenseRecord(plan.file, round.toBase58(), { buyer: backer.publicKey.toBase58(), author: author.toBase58(), scheduled: false }).catch(() => {});
        throw new Error(`${errorMessage(e)}\nMarked scheduled: false in the round file; the round runner will schedule it.`);
      }
    });

    job.status = "done";
  } catch (e) {
    job.status = "error";
    job.error = errorMessage(e);
  } finally {
    job.finishedAt = Date.now();
  }
}
