/**
 * Reads and checks for the local web backer: balances, its licenses (decoded
 * with the backer's own TEE token), and the preconditions of a new license.
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { pda } from "@blackbox/sdk";
import { DELEGATION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import type { BackStateResponse, BackerLicense, ReadRequest } from "../api-types";
import { MAX_LICENSES_PER_AUTHOR, toEntrantView, toLicenseView, toRoundView } from "../chain";
import { checkRange, formatUsdcAmount, parseUsdcInput } from "../amount";
import { shortAddr } from "../format";
import { redactToken } from "../tee-auth";
import { clientFor, isAuthError, resetClient } from "./local";
import { findRoundFile, namesFrom, type RawRoundFile } from "./round-file";
import { BACKER_NAME, FIRST_DEPOSIT, displayPath, loadOrCreateBacker } from "./backer";
import { listJobs, runningJob, type BackPlan } from "./back-jobs";

/** USDC the backer can spend on the rollup (6-dp units), or -1 before its first deposit. */
async function erBalance(kp: Keypair, mint: PublicKey): Promise<bigint> {
  const { eata } = pda.eataAccounts(kp.publicKey, mint);
  const bx = clientFor(kp);
  const info = await bx.base.getAccountInfo(eata, "confirmed").catch(() => null);
  if (!info || !info.owner.equals(DELEGATION_PROGRAM_ID)) return -1n;
  return bx.erTokenBalance(kp, mint).catch(() => -1n);
}

async function withTokenRetry<T>(kp: Keypair, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!isAuthError(e)) throw e;
    resetClient(kp); // the local TEE restarted: sign a fresh challenge
    return fn();
  }
}

export async function readBackState(file: RawRoundFile): Promise<BackStateResponse> {
  const round = new PublicKey(file.round!);
  const mint = new PublicKey(file.mint!);
  const { kp, file: keyFile } = loadOrCreateBacker();
  const me = kp.publicKey.toBase58();
  const names = namesFrom(file);
  const jobs = listJobs(round.toBase58());

  // Licenses this backer holds in this round: the round file's records plus any job's author.
  const authors = new Map<string, boolean | null>();
  for (const l of file.licenses ?? []) if (l.buyer === me) authors.set(l.author, typeof l.scheduled === "boolean" ? l.scheduled : null);
  for (const j of jobs) if (!authors.has(j.author)) authors.set(j.author, null);

  const bxOf = () => clientFor(kp);
  const ata = getAssociatedTokenAddressSync(mint, kp.publicKey);
  const [sol, usdcL1, er] = await Promise.all([
    bxOf().base.getBalance(kp.publicKey, "confirmed").catch(() => null),
    getAccount(bxOf().base, ata, "confirmed")
      .then((a) => Number(a.amount) / 1e6)
      .catch(() => 0),
    withTokenRetry(kp, () => erBalance(kp, mint)).catch(() => -1n),
  ]);

  let read: ReadRequest | null = null;
  const licenses: BackerLicense[] = [];
  if (authors.size) {
    const list = [...authors.keys()];
    const keys = list.map((a) => pda.licensePda(round, kp.publicKey, new PublicKey(a)));
    const decode = (data: Buffer): { view: BackerLicense["view"]; error: string | null } => {
      try {
        return { view: toLicenseView(bxOf().program.coder.accounts.decode("license", data)), error: null };
      } catch (e) {
        return { view: null, error: `undecodable License (${data.length} bytes): ${e instanceof Error ? e.message : String(e)}` };
      }
    };
    const push = (i: number, v: { view: BackerLicense["view"]; error: string | null }) =>
      licenses.push({ author: list[i], authorName: names.get(list[i])?.name ?? shortAddr(list[i]), license: keys[i].toBase58(), scheduled: authors.get(list[i]) ?? null, ...v });
    try {
      // L1 first: the ER is asked only about Licenses already delegated to it. An ER read of an
      // account that is not delegated yet makes the rollup clone a plain copy (see BlackboxClient.hasErDeposit).
      const l1 = await bxOf().base.getMultipleAccountsInfo(keys, "confirmed");
      const onEr = l1.map((info) => !!info && info.owner.equals(DELEGATION_PROGRAM_ID));
      const erIdx = onEr.flatMap((d, i) => (d ? [i] : []));
      const er = new Map<number, Buffer | null>();
      if (erIdx.length) {
        const { infos, endpoint, ms } = await withTokenRetry(kp, async () => {
          const conn = await bxOf().tee(kp);
          const t0 = performance.now();
          const infos = await conn.getMultipleAccountsInfo(
            erIdx.map((i) => keys[i]),
            "processed",
          );
          return { infos, endpoint: redactToken(conn.rpcEndpoint), ms: Math.round(performance.now() - t0) };
        });
        infos.forEach((info, k) => er.set(erIdx[k], info ? info.data : null));
        read = {
          label: "License (your token)",
          method: "getMultipleAccounts",
          endpoint,
          account: erIdx.length === 1 ? keys[erIdx[0]].toBase58() : `${erIdx.length} License accounts`,
          ms,
          found: infos.some(Boolean),
          bytes: infos.reduce((a, i) => a + (i?.data.length ?? 0), 0),
          owner: infos.find(Boolean)?.owner.toBase58() ?? null,
        };
      }
      list.forEach((_, i) => {
        if (onEr[i]) {
          const data = er.get(i);
          push(i, data ? decode(data) : { view: null, error: null });
        } else if (l1[i]) {
          // On L1 and owned by the program: opened but not delegated yet, or settled and returned as zeros.
          push(i, decode(l1[i]!.data));
        } else {
          push(i, { view: null, error: null });
        }
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      list.forEach((_, i) => push(i, { view: null, error: msg }));
    }
  }

  return {
    round: round.toBase58(),
    roundId: typeof file.roundId === "number" ? file.roundId : null,
    backer: {
      owner: me,
      name: BACKER_NAME,
      keyFile: displayPath(keyFile),
      solL1: sol === null ? null : sol / 1e9,
      usdcL1,
      usdcEr: er < 0n ? null : Number(er) / 1e6,
    },
    licenses,
    jobs,
    read,
    at: Date.now(),
  };
}

export class PlanError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** Every precondition the program would check, answered before any transaction is sent. */
export async function planBack(file: RawRoundFile, authorStr: string, marginStr: string): Promise<BackPlan> {
  const path = findRoundFile("local");
  if (!path || !file.round || !file.mint || !Array.isArray(file.feeds) || !file.feeds.length) throw new PlanError("the local round file is incomplete (round, mint, feeds)", 409);
  let author: PublicKey;
  try {
    author = new PublicKey(authorStr);
  } catch {
    throw new PlanError("author is not a public key");
  }
  const known = new Set([...(file.entrants ?? []), ...(file.external ?? [])].map((e) => e.owner).concat(file.entrantOwners ?? []));
  if (!known.has(author.toBase58())) throw new PlanError("author is not an entrant of the current round", 404);
  const parsed = parseUsdcInput(marginStr);
  if (!parsed.ok) throw new PlanError(parsed.error);
  if (runningJob()) throw new PlanError("a license is already being set up; wait for it to finish", 409);

  const { kp } = loadOrCreateBacker();
  if (kp.publicKey.equals(author)) throw new PlanError("the backer cannot license its own strategy");
  const round = new PublicKey(file.round);
  const mint = new PublicKey(file.mint);
  const bx = clientFor(kp);

  const r = await bx.fetchRound(round);
  if (!r) throw new PlanError("the round is not visible on the TEE", 409);
  const rv = toRoundView(r);
  if (rv.status !== "live") throw new PlanError(`licenses activate and tick only while the round is live (it is ${rv.status})`, 409);
  if (rv.durationTicks - rv.tick < 20) throw new PlanError("the round is about to end; back a strategy in the next round", 409);
  const rangeError = checkRange(parsed.micro, rv.minMargin, rv.maxMargin);
  if (rangeError) throw new PlanError(rangeError);

  const ent = await bx.fetchEntrant(round, author);
  if (!ent) throw new PlanError("the author's Entrant is not visible on the TEE", 409);
  const ev = toEntrantView(ent);
  if (!ev.alive) throw new PlanError("this strategy was liquidated", 409);
  if (ev.settled) throw new PlanError("this entrant is settled", 409);
  if (ev.licenseCount >= MAX_LICENSES_PER_AUTHOR) throw new PlanError(`this strategy already has ${MAX_LICENSES_PER_AUTHOR} licenses (the maximum)`, 409);

  // Ask the ER about the License only once it is delegated (see readBackState).
  const licL1 = await bx.base.getAccountInfo(pda.licensePda(round, kp.publicKey, author), "confirmed").catch(() => null);
  if (licL1?.owner.equals(DELEGATION_PROGRAM_ID)) {
    const lic = await withTokenRetry(kp, () => bx.fetchLicense(round, kp, kp.publicKey, author)).catch(() => null);
    if (lic && toLicenseView(lic).active) throw new PlanError("the web backer already backs this strategy in this round", 409);
  }

  // Deposit once; later licenses draw on the rollup balance.
  const er = await withTokenRetry(kp, () => erBalance(kp, mint));
  let deposit = 0n;
  if (er < parsed.micro) {
    if (er >= 0n) {
      throw new PlanError(
        `the web backer has ${formatUsdcAmount(Number(er) / 1e6)} USDC on the rollup; back with at most that much (it deposits once and later licenses draw on that balance)`,
      );
    }
    deposit = parsed.micro > FIRST_DEPOSIT ? parsed.micro : FIRST_DEPOSIT;
  }

  const names = namesFrom(file);
  return {
    file: path,
    round,
    mint,
    feeds: file.feeds.map((f) => new PublicKey(f)),
    author,
    authorName: names.get(author.toBase58())?.name ?? shortAddr(author.toBase58()),
    margin: parsed.micro,
    deposit,
  };
}
