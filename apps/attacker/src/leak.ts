/**
 * Byte-level helpers for deciding whether a blob of bytes returned by some read
 * path contains (part of) a secret.
 */
import { utils } from "@coral-xyz/anchor";

/** Strategy header: disc 8 + round 32 + owner 32 + updated_tick 8 + version 4 + step_limit 4 + len 2 + bump 1 + pad 5. */
export const STRATEGY_BYTECODE_OFFSET = 96;
/** Position header: disc 8 + round 32 + owner 32. Everything after it except the trailing bump + pad is private. */
export const POSITION_PRIVATE_OFFSET = 72;
/** Position tail: bump u8 + pad [u8; 7]. */
export const POSITION_TAIL = 8;

/** Window size used when searching for fragments of a secret. */
export const LEAK_WINDOW = 16;
/** A window must carry at least this many non-zero bytes to count as evidence. */
export const MIN_NONZERO_IN_WINDOW = 4;

function nonZero(b: Uint8Array): number {
  let n = 0;
  for (const x of b) if (x !== 0) n++;
  return n;
}

/**
 * True when `hay` contains the whole secret, or any LEAK_WINDOW-byte window of
 * it that carries enough non-zero bytes to be distinctive. Zero-heavy windows
 * are skipped so that zeroed regions never match by accident.
 */
export function containsSecret(hay: Uint8Array | null | undefined, secret: Uint8Array | null | undefined): boolean {
  if (!hay || !secret || secret.length === 0 || hay.length === 0) return false;
  const h = Buffer.from(hay.buffer, hay.byteOffset, hay.byteLength);
  const s = Buffer.from(secret.buffer, secret.byteOffset, secret.byteLength);
  if (s.length <= LEAK_WINDOW) {
    return nonZero(s) >= Math.min(MIN_NONZERO_IN_WINDOW, s.length) && h.indexOf(s) !== -1;
  }
  // A full match only counts when the secret carries real (non-zero) content;
  // an all-zero secret must never "leak" against an all-zero blob.
  if (nonZero(s) >= MIN_NONZERO_IN_WINDOW && h.indexOf(s) !== -1) return true;
  for (let i = 0; i + LEAK_WINDOW <= s.length; i++) {
    const w = s.subarray(i, i + LEAK_WINDOW);
    if (nonZero(w) < MIN_NONZERO_IN_WINDOW) continue;
    if (h.indexOf(w) !== -1) return true;
  }
  return false;
}

/** True when any of the secrets is found in any of the blobs. */
export function anySecret(blobs: (Uint8Array | null | undefined)[], secrets: (Uint8Array | null | undefined)[]): boolean {
  return blobs.some((b) => secrets.some((s) => containsSecret(b, s)));
}

export function allZero(b: Uint8Array): boolean {
  for (const x of b) if (x !== 0) return false;
  return true;
}

/** Private region of a Strategy account (the bytecode array). */
export function strategyRegion(data: Uint8Array): Uint8Array {
  return data.subarray(STRATEGY_BYTECODE_OFFSET);
}

/** Private region of a Position account (margin .. liquidated). */
export function positionRegion(data: Uint8Array): Uint8Array {
  return data.subarray(POSITION_PRIVATE_OFFSET, Math.max(POSITION_PRIVATE_OFFSET, data.length - POSITION_TAIL));
}

/** Decode a base58 string (Solana keys, signatures, JSON-encoded ix data), or null if invalid. */
export function base58Decode(s: string): Uint8Array | null {
  try {
    return Uint8Array.from(utils.bytes.bs58.decode(s));
  } catch {
    return null;
  }
}

const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Every plausible byte interpretation of a string found in an RPC response:
 * base64 (account data, transactions, `Program data:` logs), base58 (JSON-encoded
 * instruction data) and the raw UTF-8 bytes.
 */
export function stringBlobs(s: string): Uint8Array[] {
  const out: Uint8Array[] = [Buffer.from(s, "utf8")];
  if (s.length >= 8 && s.length % 4 === 0 && B64_RE.test(s)) out.push(Buffer.from(s, "base64"));
  // Log lines like "Program data: <b64>" or "Program log: <text>": decode each token too.
  for (const tok of s.split(/\s+/)) {
    if (tok !== s && tok.length >= 8 && tok.length % 4 === 0 && B64_RE.test(tok)) out.push(Buffer.from(tok, "base64"));
  }
  if (s.length >= 8 && s.length <= 12_000) {
    const b = base58Decode(s);
    if (b && b.length > 0) out.push(b);
  }
  return out;
}

/**
 * Deep-scan an arbitrary decoded JSON-RPC value (objects, arrays, strings,
 * number arrays) for any of the secrets. Returns the JSON path of the first
 * hit, or null when nothing matches.
 */
export function scanValue(value: unknown, secrets: Uint8Array[], at = "$"): string | null {
  if (secrets.length === 0 || value == null) return null;
  if (typeof value === "string") {
    for (const b of stringBlobs(value)) if (secrets.some((s) => containsSecret(b, s))) return at;
    return null;
  }
  if (value instanceof Uint8Array) return secrets.some((s) => containsSecret(value, s)) ? at : null;
  if (Array.isArray(value)) {
    if (value.length >= 8 && value.every((x) => typeof x === "number" && Number.isInteger(x) && x >= 0 && x < 256)) {
      const b = Uint8Array.from(value as number[]);
      if (secrets.some((s) => containsSecret(b, s))) return at;
    }
    for (let i = 0; i < value.length; i++) {
      const hit = scanValue(value[i], secrets, `${at}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const hit = scanValue(v, secrets, `${at}.${k}`);
      if (hit) return hit;
    }
  }
  return null;
}
