/**
 * Presentation of the bx-attack privacy matrix (apps/attacker/src/matrix.ts):
 * who made each request, and whether the path returned data. Pure functions,
 * shared by the /api/proof route and its tests.
 */
import type { ProofAccess } from "./api-types";

export interface MatrixRow {
  path: string;
  request: string;
  result: string;
  expected: string;
  pass: boolean;
}

const isOwnerRow = (path: string) => /owner token/i.test(path);

/** The identity behind a matrix row, in words. */
export function whoAsked(path: string, names: { owner?: string | null; rival?: string | null; local?: boolean } = {}): string {
  if (isOwnerRow(path)) return `the owner${names.owner ? ` (${names.owner})` : ""}, with its auth token`;
  if (/^preflight/i.test(path)) return "anyone (public Entrant)";
  if (/no token/i.test(path)) return "anyone, no auth token";
  if (/fresh token/i.test(path)) return "a brand-new wallet, with its token";
  if (/rival token/i.test(path)) return `a rival entrant${names.rival ? ` (${names.rival})` : ""}, with its token`;
  if (/^set_strategy tx/i.test(path)) return "a stranger's token and no token";
  if (/^L1 /i.test(path)) return "anyone on Solana L1";
  if (/raw ER RPC \(7799\)/i.test(path)) return "a process on this machine (dev-only port)";
  if (/raw regional ER/i.test(path)) return "anyone (non-TEE regional rollup)";
  return "anyone";
}

/** Did the path hand back the account's data (read), nothing (blocked), or is the row informational / inconclusive? */
export function accessOf(row: MatrixRow): ProofAccess {
  const res = row.result;
  if (/^preflight/i.test(row.path) || /raw ER RPC \(7799\)/i.test(row.path)) return "info";
  if (/^LEAK/i.test(res)) return "read";
  if (isOwnerRow(row.path)) return /bytes readable/i.test(res) ? "read" : /^error|inconclusive/i.test(res) ? "error" : "blocked";
  if (/inconclusive|^error:|unreachable/i.test(res)) return "error";
  return "blocked";
}
