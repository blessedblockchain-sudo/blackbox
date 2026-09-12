"use client";
/**
 * What a connected wallet owns in this round, read from the browser.
 *
 * Three reads, deliberately kept apart:
 *  - balances: SOL and the round's test USDC on Solana L1, plus what the wallet
 *    has spendable inside the rollup (that one needs the TEE auth token);
 *  - authors: the round's entrants, from the public Scoreboard, so the guided
 *    path works even on a round this build was not baked with;
 *  - licences: the wallet's own License accounts. Their existence is public
 *    (open_license is an L1 transaction); their contents are not, and come back
 *    only because the wallet's token is a member of the License permission.
 *
 * L1 is a shared public RPC, so those polls are slow on purpose.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Connection, PublicKey } from "@solana/web3.js";
import type { PublicRoundInfo } from "./api-types";
import { decodeAccount, licensePda, scoreboardPda, toLicenseView, toScoreboardView, type LicenseView } from "./chain";
import { DELEGATION_PROGRAM_ID, ata, ephemeralAta, tokenAmount } from "./espl";
import { shortAddr } from "./format";
import { redactToken, tokenUrl } from "./tee-auth";
import { rpcConnection } from "./rpc";

// ------------------------------------------------------------------ balances

export interface WalletFunds {
  /** SOL on Solana L1. */
  sol: number | null;
  /** The round's test USDC in the wallet's associated token account (0n when the account is missing). */
  usdcL1: bigint | null;
  /** Test USDC spendable inside the rollup; null until the wallet has deposited or has no token. */
  usdcEr: bigint | null;
  /** The wallet's ephemeral ATA exists on L1 and is delegated: it has deposited once already. */
  deposited: boolean;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

const NO_FUNDS: WalletFunds = { sol: null, usdcL1: null, usdcEr: null, deposited: false, loading: false, error: null, refresh: () => {} };

export function useWalletFunds(info: PublicRoundInfo | null, owner: string | null, token: string | null, ms = 6000): WalletFunds {
  const [state, setState] = useState<Omit<WalletFunds, "refresh">>(NO_FUNDS);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  const base = info?.endpoints.base ?? null;
  const tee = info?.endpoints.tee ?? null;
  const mint = info?.mint ?? null;

  useEffect(() => {
    if (!owner || !mint || !base) {
      setState(NO_FUNDS);
      return;
    }
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setState((p) => ({ ...p, loading: true }));
    const conn = rpcConnection(base, { commitment: "confirmed" });
    const me = new PublicKey(owner);
    const mintKey = new PublicKey(mint);
    const teeConn = token && tee ? rpcConnection(tokenUrl(tee, token), { commitment: "processed" }) : null;

    const load = async () => {
      try {
        const [sol, [usdcInfo, eataInfo]] = await Promise.all([
          conn.getBalance(me, "confirmed"),
          conn.getMultipleAccountsInfo([ata(mintKey, me), ephemeralAta(me, mintKey)], "confirmed"),
        ]);
        // Read the rollup balance only once the ephemeral ATA is delegated: an
        // earlier read makes the ER clone the ATA as a plain account that later
        // writes reject (BlackboxClient.hasErDeposit).
        const deposited = !!eataInfo && eataInfo.owner.equals(DELEGATION_PROGRAM_ID);
        let usdcEr: bigint | null = null;
        if (deposited && teeConn) usdcEr = tokenAmount((await teeConn.getAccountInfo(ata(mintKey, me), "processed"))?.data) ?? 0n;
        if (!stop) setState({ sol: sol / 1e9, usdcL1: tokenAmount(usdcInfo?.data) ?? 0n, usdcEr, deposited, loading: false, error: null });
      } catch (e) {
        if (!stop) setState((p) => ({ ...p, loading: false, error: e instanceof Error ? e.message : String(e) }));
      }
      if (!stop) timer = setTimeout(load, document.hidden ? ms * 4 : ms);
    };
    load();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [owner, mint, base, tee, token, ms, nonce]);

  return { ...state, refresh };
}

// ------------------------------------------------------------------ authors

export interface AuthorMeta {
  owner: string;
  name: string;
}

/**
 * Everyone who can be backed in this round: the names this build knows plus
 * whoever the public Scoreboard lists (a round created after the build, or an
 * entrant who joined after it, still shows up).
 */
export function useAuthors(info: PublicRoundInfo | null, ms = 10_000): AuthorMeta[] {
  const [chain, setChain] = useState<string[]>([]);
  const round = info?.round ?? null;
  const tee = info?.endpoints.tee ?? null;

  useEffect(() => {
    setChain([]);
    if (!round || !tee) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const conn = rpcConnection(tee, { commitment: "processed" });
    const key = scoreboardPda(new PublicKey(round));
    const load = async () => {
      try {
        const acc = await conn.getAccountInfo(key, "processed");
        const owners = acc ? toScoreboardView(decodeAccount("scoreboard", acc.data)).entries.map((e) => e.owner) : [];
        if (!stop) setChain((prev) => (prev.length === owners.length && prev.every((o, i) => o === owners[i]) ? prev : owners));
      } catch {
        /* dark round or RPC blip: the baked names still render */
      }
      if (!stop) timer = setTimeout(load, document.hidden ? ms * 3 : ms);
    };
    load();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [round, tee, ms]);

  const named = info?.entrants ?? [];
  const owners = info?.entrantOwners ?? [];
  const key = `${named.map((e) => `${e.owner}:${e.name}`).join(",")}|${owners.join(",")}|${chain.join(",")}`;
  return useMemo(() => {
    const names = new Map(named.map((e) => [e.owner, e.name]));
    const seen = new Set<string>();
    const out: AuthorMeta[] = [];
    for (const owner of [...named.map((e) => e.owner), ...owners, ...chain]) {
      if (seen.has(owner)) continue;
      seen.add(owner);
      out.push({ owner, name: names.get(owner) || shortAddr(owner) });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

// ------------------------------------------------------------------ licences

export interface WalletLicenseRow {
  author: string;
  authorName: string;
  license: string;
  /** The License account exists on L1. Public: open_license is an ordinary Solana transaction. */
  onChain: boolean;
  /** Handed to the TEE validator, so its body lives on the rollup. */
  delegated: boolean;
  view: LicenseView | null;
  error: string | null;
}

export interface WalletLicenses {
  rows: WalletLicenseRow[];
  /** Licences whose body came back from the TEE for this token. */
  readable: number;
  /** The authenticated read behind `rows`, for the "who could read this" line. */
  endpoint: string | null;
  ms: number | null;
  status: "idle" | "loading" | "ok" | "error";
  error: string | null;
  refresh: () => void;
}

const NO_LICENSES: Omit<WalletLicenses, "refresh"> = { rows: [], readable: 0, endpoint: null, ms: null, status: "idle", error: null };

/**
 * The wallet's own licences in this round. One batched L1 read finds which
 * exist; the bodies of the delegated ones are then read from the TEE with the
 * wallet's token, which is the only reason they come back at all.
 */
export function useWalletLicenses(info: PublicRoundInfo | null, owner: string | null, token: string | null, authors: AuthorMeta[], ms = 2500): WalletLicenses {
  const [state, setState] = useState(NO_LICENSES);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  const round = info?.round ?? null;
  const base = info?.endpoints.base ?? null;
  const tee = info?.endpoints.tee ?? null;
  const authorKey = authors.map((a) => `${a.owner}:${a.name}`).join(",");

  useEffect(() => {
    if (!round || !owner || !base || !authors.length) {
      setState(NO_LICENSES);
      return;
    }
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setState((p) => ({ ...p, status: p.rows.length ? p.status : "loading" }));
    const conn = rpcConnection(base, { commitment: "confirmed" });
    const teeConn = token && tee ? rpcConnection(tokenUrl(tee, token), { commitment: "processed" }) : null;
    const r = new PublicKey(round);
    const buyer = new PublicKey(owner);
    const keys = authors.map((a) => licensePda(r, buyer, new PublicKey(a.owner)));

    const load = async () => {
      try {
        const l1 = await conn.getMultipleAccountsInfo(keys, "confirmed");
        const found = l1.map((acc, i) => ({ i, acc })).filter((x) => !!x.acc);
        const delegated = found.filter((x) => x.acc!.owner.equals(DELEGATION_PROGRAM_ID));
        let bodies: (Uint8Array | null)[] = delegated.map(() => null);
        let elapsed: number | null = null;
        if (delegated.length && teeConn) {
          const t0 = performance.now();
          const er = await teeConn.getMultipleAccountsInfo(delegated.map((x) => keys[x.i]), "processed");
          elapsed = Math.round(performance.now() - t0);
          bodies = er.map((a) => a?.data ?? null);
        }
        const byIndex = new Map(delegated.map((x, k) => [x.i, bodies[k]]));
        const rows: WalletLicenseRow[] = found.map(({ i, acc }) => {
          const isDelegated = acc!.owner.equals(DELEGATION_PROGRAM_ID);
          const data = isDelegated ? byIndex.get(i) ?? null : acc!.data;
          let view: LicenseView | null = null;
          let error: string | null = null;
          try {
            if (data) view = toLicenseView(decodeAccount("license", data));
          } catch (e) {
            error = e instanceof Error ? e.message : String(e);
          }
          return { author: authors[i].owner, authorName: authors[i].name, license: keys[i].toBase58(), onChain: true, delegated: isDelegated, view, error };
        });
        if (!stop)
          setState({
            rows,
            readable: rows.filter((x) => x.view && !x.view.scrubbed).length,
            endpoint: teeConn ? redactToken(teeConn.rpcEndpoint) : null,
            ms: elapsed,
            status: "ok",
            error: null,
          });
      } catch (e) {
        if (!stop) setState((p) => ({ ...p, status: "error", error: e instanceof Error ? e.message : String(e) }));
      }
      if (!stop) timer = setTimeout(load, document.hidden ? ms * 4 : ms);
    };
    load();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [round, owner, token, base, tee, authorKey, ms, nonce]);

  return { ...state, refresh };
}
