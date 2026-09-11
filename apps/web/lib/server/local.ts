/**
 * Identity helpers for the dev-only /api/local/* routes. Secret keys are loaded
 * from the round file per request and never serialized.
 */
import { Keypair } from "@solana/web3.js";
import { BlackboxClient } from "@blackbox/sdk";
import { readRoundFile, type RawEntrant, type RawRoundFile } from "./round-file";

export function roundFileOrThrow(): RawRoundFile {
  const f = readRoundFile("local");
  if (!f?.round) throw new Error("no local round file (.mb/round-local.json)");
  return f;
}

export function ownerKeypair(file: RawRoundFile, owner: string): Keypair | null {
  const all: RawEntrant[] = [...(file.entrants ?? []), ...(file.external ?? [])];
  const e = all.find((x) => x.owner === owner);
  if (!e || !Array.isArray(e.secretKey) || e.secretKey.length !== 64) return null;
  const kp = Keypair.fromSecretKey(Uint8Array.from(e.secretKey));
  return kp.publicKey.toBase58() === owner ? kp : null;
}

// One client per identity, kept across hot reloads so TEE tokens are reused.
const g = globalThis as unknown as { __bxClients?: Map<string, BlackboxClient> };
export function clientFor(kp: Keypair): BlackboxClient {
  g.__bxClients ??= new Map();
  const k = kp.publicKey.toBase58();
  let c = g.__bxClients.get(k);
  if (!c) {
    c = new BlackboxClient(kp, "local");
    g.__bxClients.set(k, c);
  }
  return c;
}

/** Drop a cached client (its TEE token dies when the local stack restarts). */
export function resetClient(kp: Keypair) {
  g.__bxClients?.delete(kp.publicKey.toBase58());
}

/** True for errors that mean the TEE rejected our token. */
export const isAuthError = (e: unknown) => /\b401\b|unauthori[sz]ed|invalid token|token expired/i.test(e instanceof Error ? e.message : String(e));

export function errorMessage(e: unknown): string {
  const s = e instanceof Error ? e.message : String(e);
  return s.split("\n").slice(0, 6).join("\n").slice(0, 800);
}
