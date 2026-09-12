/**
 * Browser RPC with backoff.
 *
 * The site is a static export, so every read goes straight from the visitor's
 * browser to a public endpoint — `api.devnet.solana.com` for L1 and the TEE RPC
 * for the rollup. Both throttle, and a devnet socket drops now and then. A page
 * that gives up on the first 429 looks broken to the one judge whose request
 * happened to land on it, so retry the transient statuses and the thrown
 * network errors before surfacing anything.
 *
 * Deliberately not a second endpoint: MagicBlock's router answers L1 reads too,
 * but it routes delegated accounts to the rollup, and several call sites here
 * depend on seeing the L1 truth for an account that is currently delegated.
 */
import { Connection, type Commitment, type ConnectionConfig } from "@solana/web3.js";

const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 350;
const MAX_DELAY_MS = 3000;

export async function rpcFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  let delay = BASE_DELAY_MS;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(input, init);
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) throw err;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, MAX_DELAY_MS);
      continue;
    }
    if ((res.status !== 429 && res.status < 500) || attempt >= MAX_ATTEMPTS) return res;
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, MAX_DELAY_MS);
  }
}

/** `new Connection(...)` with the retrying fetch already wired in. */
export function rpcConnection(endpoint: string, config?: Commitment | ConnectionConfig): Connection {
  const c: ConnectionConfig = typeof config === "string" ? { commitment: config } : (config ?? {});
  return new Connection(endpoint, { ...c, fetch: rpcFetch as unknown as ConnectionConfig["fetch"] });
}
