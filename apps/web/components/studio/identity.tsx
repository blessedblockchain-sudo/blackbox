"use client";
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletReadyState, type WalletName } from "@solana/wallet-adapter-base";
import { Bot, KeyRound, Wallet } from "lucide-react";
import type { PublicEntrant, PublicRoundInfo } from "../../lib/api-types";
import { shortAddr } from "../../lib/format";
import { getAuthToken } from "../../lib/tee-auth";
import { Badge, Button, Panel, PanelHeader } from "../ui";
import type { Identity } from "./use-owner";

type Mode = "bot" | "wallet";

export function IdentityPanel({ info, identity, onChange }: { info: PublicRoundInfo; identity: Identity | null; onChange: (id: Identity | null) => void }) {
  const [mode, setMode] = useState<Mode>(info.localRoutes ? "bot" : "wallet");
  return (
    <Panel>
      <PanelHeader title="Identity" meta={identity ? shortAddr(identity.owner) : "not selected"} />
      <div className="px-3 pt-3">
        <div role="tablist" aria-label="Identity source" className="grid grid-cols-2 border border-edge">
          <TabButton active={mode === "bot"} onClick={() => setMode("bot")} disabled={!info.localRoutes} title={info.localRoutes ? undefined : "Only on a local round, served from localhost"}>
            <Bot aria-hidden className="size-3.5" /> Act as bot
          </TabButton>
          <TabButton active={mode === "wallet"} onClick={() => setMode("wallet")}>
            <Wallet aria-hidden className="size-3.5" /> Wallet
          </TabButton>
        </div>
      </div>
      <div className="p-3">
        {mode === "bot" ? <BotPicker info={info} identity={identity} onChange={onChange} /> : <WalletPicker info={info} identity={identity} onChange={onChange} />}
      </div>
    </Panel>
  );
}

function TabButton({ active, children, ...rest }: { active: boolean; children: React.ReactNode } & React.ComponentPropsWithoutRef<"button">) {
  return (
    <button
      role="tab"
      aria-selected={active}
      className={clsx(
        "flex min-h-9 items-center justify-center gap-2 font-mono text-xs tracking-[0.06em] uppercase transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40",
        active ? "bg-surface-2 text-fg" : "text-fg-dim hover:text-fg",
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

function BotPicker({ info, identity, onChange }: { info: PublicRoundInfo; identity: Identity | null; onChange: (id: Identity | null) => void }) {
  const bots: PublicEntrant[] = info.entrants.filter((e) => e.canActAs);
  if (!info.localRoutes) return <p className="text-sm text-fg-dim">Bot identities are served only for a local round, from localhost. Connect a wallet instead.</p>;
  if (!bots.length) return <p className="text-sm text-fg-dim">The local round file lists no identities with keys. Start a round with scripts/run-round.ts.</p>;
  return (
    <fieldset>
      <legend className="mb-2 text-xs text-fg-dim">Keys stay on the local server. It signs the TEE challenge and hot-swaps for you; the browser only sees decoded results.</legend>
      <div className="grid grid-cols-2 gap-1">
        {bots.map((b) => {
          const selected = identity?.kind === "bot" && identity.owner === b.owner;
          return (
            <label
              key={b.owner}
              className={clsx(
                "flex min-h-10 cursor-pointer items-center gap-2 border px-2 py-1.5 transition-colors duration-150 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-gain",
                selected ? "border-gain/50 bg-gain-deep" : "border-edge hover:border-edge-strong",
              )}
            >
              <input type="radio" name="bot" className="sr-only" checked={selected} onChange={() => onChange({ kind: "bot", owner: b.owner, name: b.name })} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-xs text-fg">{b.name || shortAddr(b.owner)}</span>
                <span className="num block text-[11px] text-fg-dim">{shortAddr(b.owner)}</span>
              </span>
              {b.external ? <Badge tone="dim">agent</Badge> : null}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/**
 * Connect a Wallet Standard wallet and sign the TEE login challenge (also used
 * by /back on devnet).
 *
 * Everything here depends on what is installed in the visitor's browser, which
 * the prerendered HTML cannot know, so the whole body waits for mount: without
 * that, a page built with no wallet and opened with one hydrates into a
 * mismatch and React throws the subtree away.
 */
export function WalletPicker({ info, identity, onChange }: { info: PublicRoundInfo; identity: Identity | null; onChange: (id: Identity | null) => void }) {
  const { wallets, wallet, select, connect, disconnect, connected, connecting, publicKey, signMessage } = useWallet();
  const [pending, setPending] = useState(false);
  const [authing, setAuthing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const available = wallets.filter((w) => w.readyState === WalletReadyState.Installed || w.readyState === WalletReadyState.Loadable);

  // `select()` only stores the choice; `connect()` refuses until the provider has
  // resolved that name to an adapter, a render later. Read the live context
  // through a ref and poll it, rather than depending on an effect firing with
  // exactly the right combination of states.
  const live = useRef({ wallet, connect, connected, connecting });
  live.current = { wallet, connect, connected, connecting };

  const pick = async (name: WalletName) => {
    setError(null);
    select(name);
    setPending(true);
    try {
      for (let i = 0; i < 120; i++) {
        const s = live.current;
        if (s.connected) return;
        if (s.wallet && !s.connecting) return await s.connect();
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`${name} did not respond. Unlock the extension and try again.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  };

  // Track the connected wallet as the identity (token cleared on account change).
  const pk = publicKey?.toBase58() ?? null;
  useEffect(() => {
    if (!pk) {
      if (identity?.kind === "wallet") onChange(null);
      return;
    }
    if (identity?.kind !== "wallet" || identity.owner !== pk) onChange({ kind: "wallet", owner: pk, token: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pk]);

  const signIn = async () => {
    if (!pk || !signMessage) return;
    setAuthing(true);
    setError(null);
    try {
      const { token } = await getAuthToken(info.endpoints.tee, pk, signMessage);
      onChange({ kind: "wallet", owner: pk, token });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAuthing(false);
    }
  };

  if (!mounted) return <p className="text-sm text-fg-dim">Looking for a wallet in this browser…</p>;

  if (!connected) {
    return (
      <div>
        {available.length ? (
          <div className="grid grid-cols-2 gap-1">
            {available.map((w) => (
              <button
                key={w.adapter.name}
                onClick={() => void pick(w.adapter.name)}
                disabled={pending}
                className="flex min-h-10 items-center gap-2 border border-edge px-2 text-left font-mono text-xs text-fg transition-colors duration-150 hover:border-edge-strong disabled:opacity-50"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {w.adapter.icon ? <img src={w.adapter.icon} alt="" className="size-4" /> : null}
                {w.adapter.name}
              </button>
            ))}
          </div>
        ) : (
          <p className="text-sm text-fg-dim">No Solana wallet detected in this browser. Install Phantom, Solflare or Backpack{info.localRoutes ? ", or act as a bot on this local round" : ""}.</p>
        )}
        {connecting || pending ? <p className="mt-2 text-xs text-fg-dim">Waiting for the wallet…</p> : null}
        {error ? <p className="mt-2 text-xs text-loss" role="alert">{error}</p> : null}
      </div>
    );
  }

  const token = identity?.kind === "wallet" ? identity.token : null;
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="font-mono text-xs text-fg">{wallet?.adapter.name}</div>
          <div className="num text-[11px] text-fg-dim">{shortAddr(pk, 6, 6)}</div>
        </div>
        <Button variant="ghost" onClick={() => disconnect()}>
          Disconnect
        </Button>
      </div>
      {token ? (
        <Badge tone="gain">
          <KeyRound aria-hidden className="size-3" /> TEE token held in memory
        </Badge>
      ) : (
        <>
          <p className="text-xs text-fg-dim">Sign the TEE login challenge to read your private accounts. Signing a message costs nothing and moves no funds.</p>
          <Button variant="primary" onClick={signIn} disabled={authing || !signMessage}>
            <KeyRound aria-hidden className="size-3.5" /> {authing ? "Signing…" : "Sign in to TEE"}
          </Button>
          {!signMessage ? <p className="text-xs text-warn">This wallet cannot sign messages.</p> : null}
        </>
      )}
      {error ? <p className="text-xs text-loss" role="alert">{error}</p> : null}
    </div>
  );
}
