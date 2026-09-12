"use client";
import { useEffect, useState } from "react";
import { Connection, PublicKey } from "@solana/web3.js";
import { b64decode, type OwnerReadResponse, type ReadRequest } from "../../lib/api-types";
import { decodeAccount, positionPda, strategyPda, toPositionView, toStrategyView, type PositionView, type StrategyView } from "../../lib/chain";
import { redactToken, tokenUrl } from "../../lib/tee-auth";
import { rpcConnection } from "../../lib/rpc";

export type Identity =
  | { kind: "bot"; owner: string; name: string }
  | { kind: "wallet"; owner: string; token: string | null };

export interface OwnerReads {
  strategy: StrategyView | null;
  position: PositionView | null;
  strategyHash: string;
  requests: ReadRequest[];
  status: "idle" | "loading" | "ok" | "error" | "unauthenticated";
  error: string | null;
  lastOk: number | null;
}

const IDLE: OwnerReads = { strategy: null, position: null, strategyHash: "", requests: [], status: "idle", error: null, lastOk: null };

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Authenticated reads of the identity's own Strategy and Position, refreshed every `ms`. */
export function useOwnerReads(identity: Identity | null, round: string | null, tee: string | null, ms = 1500, nonce = 0): OwnerReads {
  const [state, setState] = useState<OwnerReads>(IDLE);
  const key = identity ? `${identity.kind}:${identity.owner}:${identity.kind === "wallet" ? identity.token ?? "" : ""}` : "";

  useEffect(() => {
    if (!identity || !round || !tee) {
      setState(IDLE);
      return;
    }
    if (identity.kind === "wallet" && !identity.token) {
      setState({ ...IDLE, status: "unauthenticated" });
      return;
    }
    setState({ ...IDLE, status: "loading" });
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const readBot = async (): Promise<Partial<OwnerReads>> => {
      const res = await fetch(`/api/local/owner?owner=${identity.owner}`, { cache: "no-store" });
      const body = (await res.json()) as OwnerReadResponse | { error: string };
      if (!res.ok || "error" in body) throw new Error("error" in body ? body.error : `HTTP ${res.status}`);
      const s = body.strategy;
      return {
        strategy: s ? { version: s.version, len: s.len, stepLimit: s.stepLimit, updatedTick: s.updatedTick, bytecode: b64decode(s.bytecodeB64) } : null,
        strategyHash: s?.sha256 ?? "",
        position: body.position,
        requests: body.requests,
      };
    };

    const conn = identity.kind === "wallet" && identity.token ? rpcConnection(tokenUrl(tee, identity.token), { commitment: "processed" }) : null;
    const readWallet = async (): Promise<Partial<OwnerReads>> => {
      const owner = new PublicKey(identity.owner);
      const r = new PublicKey(round);
      const keys = [strategyPda(r, owner), positionPda(r, owner)];
      const t0 = performance.now();
      const [si, pi] = await conn!.getMultipleAccountsInfo(keys, "processed");
      const elapsed = Math.round(performance.now() - t0);
      const endpoint = redactToken(conn!.rpcEndpoint);
      const strategy = si ? toStrategyView(decodeAccount("strategy", si.data)) : null;
      return {
        strategy,
        strategyHash: strategy ? await sha256Hex(strategy.bytecode) : "",
        position: pi ? toPositionView(decodeAccount("position", pi.data)) : null,
        requests: [
          { label: "Strategy (your token)", method: "getMultipleAccounts", endpoint, account: keys[0].toBase58(), ms: elapsed, found: !!si, bytes: si?.data.length ?? 0, owner: si?.owner.toBase58() ?? null },
          { label: "Position (your token)", method: "getMultipleAccounts", endpoint, account: keys[1].toBase58(), ms: elapsed, found: !!pi, bytes: pi?.data.length ?? 0, owner: pi?.owner.toBase58() ?? null },
        ],
      };
    };

    const loop = async () => {
      try {
        const next = identity.kind === "bot" ? await readBot() : await readWallet();
        if (!stop) setState((prev) => ({ ...prev, ...next, status: "ok", error: null, lastOk: Date.now() }));
      } catch (e) {
        if (!stop) setState((prev) => ({ ...prev, status: "error", error: e instanceof Error ? e.message : String(e) }));
      }
      if (!stop) timer = setTimeout(loop, document.hidden ? ms * 4 : ms);
    };
    loop();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, round, tee, ms, nonce]);

  return state;
}
