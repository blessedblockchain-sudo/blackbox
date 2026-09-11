/**
 * Runs the bx-attack privacy matrix (apps/attacker) against one entrant of the
 * current round. On a local round served to localhost, the round file's bot
 * key for the target provides the owner-token control rows, and another bot's
 * key the rival-token rows; nothing else is trusted to the server.
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import { runMatrix } from "@blackbox/attacker";
import type { Cluster, ProofResponse } from "../api-types";
import { accessOf, whoAsked } from "../proof";
import { shortAddr } from "../format";
import { ownerKeypair } from "./local";
import { namesFrom, type RawRoundFile } from "./round-file";

const g = globalThis as unknown as { __bxProofBusy?: boolean };

export class ProofBusyError extends Error {}

const TIMEOUT_MS = 90_000;

export async function runProof(cluster: Cluster, file: RawRoundFile, target: PublicKey, useKeys: boolean): Promise<ProofResponse> {
  if (g.__bxProofBusy) throw new ProofBusyError("a matrix run is already in progress; try again in a few seconds");
  g.__bxProofBusy = true;
  try {
    const round = new PublicKey(file.round!);
    const names = namesFrom(file);
    const targetStr = target.toBase58();
    const ownerKp = useKeys ? ownerKeypair(file, targetStr) : null;
    let rivalKp: Keypair | null = null;
    let rivalName: string | null = null;
    if (useKeys) {
      for (const e of [...(file.entrants ?? []), ...(file.external ?? [])]) {
        if (e.owner === targetStr) continue;
        const kp = ownerKeypair(file, e.owner);
        if (kp) {
          rivalKp = kp;
          rivalName = String(e.name ?? shortAddr(e.owner));
          break;
        }
      }
    }
    const t0 = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const rows = await Promise.race([
      runMatrix({ cluster, round, target, ownerKp: ownerKp ?? undefined, rivalKp: rivalKp ?? undefined }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`the matrix did not finish within ${TIMEOUT_MS / 1000} s`)), TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
    const targetName = names.get(targetStr)?.name ?? shortAddr(targetStr);
    const out = rows.map((r) => ({
      path: r.path,
      who: whoAsked(r.path, { owner: targetName, rival: rivalName, local: cluster === "local" }),
      request: r.request,
      result: r.result,
      expected: r.expected,
      access: accessOf(r),
      pass: r.pass,
    }));
    const failed = out.filter((r) => !r.pass).length;
    return {
      cluster,
      round: round.toBase58(),
      target: targetStr,
      targetName,
      ownerToken: !!ownerKp,
      rival: rivalName,
      rows: out,
      passed: out.length - failed,
      failed,
      ms: Date.now() - t0,
      at: Date.now(),
    };
  } finally {
    g.__bxProofBusy = false;
  }
}
