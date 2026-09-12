"use client";
import { useState } from "react";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { useWallet } from "@solana/wallet-adapter-react";
import { ArrowRightLeft } from "lucide-react";
import type { HotSwapResponse, PublicRoundInfo } from "../../lib/api-types";
import { b64encode } from "../../lib/api-types";
import { setStrategyIxs } from "../../lib/chain";
import { erTxExplorer } from "../../lib/explorer";
import { formatInt, shortAddr } from "../../lib/format";
import { tokenUrl } from "../../lib/tee-auth";
import { Badge, Button, ExtLink, Panel, PanelHeader } from "../ui";
import type { Identity } from "./use-owner";
import { rpcConnection } from "../../lib/rpc";

type Phase = { k: "idle" } | { k: "confirm" } | { k: "sending" } | { k: "done"; res: HotSwapResponse } | { k: "error"; msg: string };

export function HotSwapPanel({
  info,
  identity,
  bytecode,
  currentVersion,
  roundLive,
  onSwapped,
}: {
  info: PublicRoundInfo;
  identity: Identity | null;
  bytecode: Uint8Array | null;
  currentVersion: number | null;
  roundLive: boolean;
  onSwapped: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ k: "idle" });
  const { signTransaction } = useWallet();
  const authed = identity?.kind === "bot" || (identity?.kind === "wallet" && !!identity.token);
  const reason = !identity
    ? "Pick an identity first."
    : !authed
      ? "Sign in to the TEE first."
      : !bytecode
        ? "Fix compile errors first."
        : !roundLive
          ? "Hot-swaps are accepted while the round is open or live."
          : identity.kind === "wallet" && !signTransaction
            ? "This wallet cannot sign transactions."
            : null;

  const send = async () => {
    if (!identity || !bytecode) return;
    setPhase({ k: "sending" });
    try {
      let res: HotSwapResponse;
      if (identity.kind === "bot") {
        const r = await fetch("/api/local/hot-swap", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ owner: identity.owner, bytecode: b64encode(bytecode) }),
        });
        const body = (await r.json()) as HotSwapResponse | { error: string };
        if (!r.ok || "error" in body) throw new Error("error" in body ? body.error : `HTTP ${r.status}`);
        res = body;
      } else {
        if (!identity.token || !signTransaction || !info.round) throw new Error("wallet not ready");
        const conn = rpcConnection(tokenUrl(info.endpoints.tee, identity.token), { commitment: "confirmed" });
        const owner = new PublicKey(identity.owner);
        const tx = new Transaction().add(...setStrategyIxs(new PublicKey(info.round), owner, bytecode));
        tx.feePayer = owner;
        tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
        const signed = await signTransaction(tx);
        const sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: true });
        const conf = await conn.confirmTransaction(sig, "confirmed");
        if (conf.value.err) throw new Error(`set_strategy failed on the ER: ${JSON.stringify(conf.value.err)} (${sig})`);
        res = { sig, explorer: erTxExplorer(sig, info.cluster, info.endpoints.tee), version: currentVersion !== null ? currentVersion + 1 : null, len: bytecode.length };
      }
      setPhase({ k: "done", res });
      onSwapped();
    } catch (e) {
      setPhase({ k: "error", msg: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <Panel>
      <PanelHeader title="Hot-swap" meta={identity ? `as ${identity.kind === "bot" ? identity.name : shortAddr(identity.owner)}` : undefined} />
      <div className="space-y-3 px-3 py-3">
        <p className="text-xs text-fg-dim">
          Sends <span className="font-mono text-fg-muted">set_strategy</span> to the rollup. The new bytecode lands in your private Strategy account; the only public trace is the entrant&apos;s version counter. Ticks after the swap run the new code.
        </p>
        {phase.k === "confirm" ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" onClick={send} autoFocus>
              Confirm: v{currentVersion ?? "?"} → v{currentVersion !== null ? currentVersion + 1 : "?"} ({formatInt(bytecode?.length ?? 0)} B)
            </Button>
            <Button variant="ghost" onClick={() => setPhase({ k: "idle" })}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button variant="primary" disabled={!!reason || phase.k === "sending"} onClick={() => setPhase({ k: "confirm" })}>
            <ArrowRightLeft aria-hidden className="size-3.5" />
            {phase.k === "sending" ? "Sending to the rollup…" : "Hot-swap strategy"}
          </Button>
        )}
        {reason && phase.k !== "sending" ? <p className="text-xs text-fg-dim">{reason}</p> : null}
        <div aria-live="polite">
          {phase.k === "done" ? (
            <div className="space-y-1 border border-gain/30 bg-gain-deep px-3 py-2 text-xs">
              <div className="flex items-center gap-2">
                <Badge tone="gain">Swapped</Badge>
                <span className="text-fg-muted">
                  strategy v{phase.res.version ?? "?"} · {formatInt(phase.res.len)} bytes sealed
                </span>
              </div>
              <div className="num break-all text-fg-muted">
                ER tx <ExtLink href={phase.res.explorer}>{shortAddr(phase.res.sig, 10, 10)}</ExtLink>
              </div>
              <p className="text-fg-dim">Opened without your token, the rollup returns this transaction without the bytecode in its message.</p>
            </div>
          ) : phase.k === "error" ? (
            <p className="border border-loss/30 bg-loss-deep px-3 py-2 text-xs break-words whitespace-pre-wrap text-loss" role="alert">
              {phase.msg}
            </p>
          ) : null}
        </div>
      </div>
    </Panel>
  );
}
