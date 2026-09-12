"use client";
/**
 * The guided path a visitor follows to use BLACKBOX on devnet with nothing but
 * a browser wallet: connect, get devnet SOL, get test USDC from the faucet key
 * this site ships, back a sealed strategy, then watch it and check that nobody
 * else can read it.
 *
 * Every step reports its own state from the chain, so the panel is a status
 * display rather than a checklist the visitor has to keep in their head. It is
 * rendered on the landing page and on /back; the two share one wallet session
 * (lib/wallet-identity.ts).
 */
import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import clsx from "clsx";
import { Check, Coins, ExternalLink, Wallet } from "lucide-react";
import { PublicKey, Transaction } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import type { PublicRoundInfo } from "../../lib/api-types";
import { formatSol, formatUsdcAmount } from "../../lib/amount";
import { FAUCET_AMOUNT, checkFaucet, faucetAuthority, faucetKeypair, faucetMintIxs, faucetProblem, type FaucetStatus } from "../../lib/faucet";
import { baseTxExplorer } from "../../lib/explorer";
import { shortAddr } from "../../lib/format";
import { useRoundInfo } from "../../lib/hooks";
import { identityOwner, identityToken, useSharedIdentity } from "../../lib/wallet-identity";
import { useAuthors, useWalletFunds, useWalletLicenses } from "../../lib/wallet-hooks";
import { WalletPicker } from "../studio/identity";
import { Button, ExtLink, Panel, PanelHeader, Skeleton } from "../ui";

/**
 * What the whole path costs in devnet SOL. Measured end to end on devnet round
 * #6: 0.0161 SOL — 0.0020 for the token account the faucet creates and 0.0141
 * for the licence's own accounts and the five transaction fees. Most of it is
 * rent for accounts the visitor owns, not a fee.
 */
export const SOL_NEEDED = 0.02;
/** Below this, backing will fail partway through, so the step is not "done". */
const SOL_FOR_BACKING = 0.02;

const SOL_FAUCET = "https://faucet.solana.com";

type State = "done" | "now" | "later";

function Marker({ state, n }: { state: State; n: number }) {
  return (
    <span
      aria-hidden
      className={clsx(
        "num mt-px flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px] leading-none",
        state === "done" ? "border-gain/50 bg-gain-deep text-gain" : state === "now" ? "border-fg text-fg" : "border-edge text-fg-faint",
      )}
    >
      {state === "done" ? <Check className="size-3" strokeWidth={2.5} /> : n}
    </span>
  );
}

function Step({ n, state, title, cost, children }: { n: number; state: State; title: string; cost: string; children?: ReactNode }) {
  return (
    <li className="flex gap-3 border-t border-edge px-3 py-2.5 first:border-t-0">
      <Marker state={state} n={n} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <span className={clsx("text-[13px]", state === "later" ? "text-fg-dim" : "text-fg")}>{title}</span>
          <span className="label-caps !text-[10px]">{cost}</span>
          <span className="sr-only">: {state === "done" ? "done" : state === "now" ? "do this next" : "not yet"}</span>
        </div>
        {children ? <div className="mt-1.5 space-y-1.5 text-xs text-fg-muted">{children}</div> : null}
      </div>
    </li>
  );
}

/** "Get test USDC": the visitor pays the fee, the committed faucet key co-signs mint_to. */
function FaucetButton({ info, owner, onMinted }: { info: PublicRoundInfo; owner: string; onMinted: () => void }) {
  const { connection } = useConnection();
  const { sendTransaction } = useWallet();
  const [status, setStatus] = useState<FaucetStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [sig, setSig] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    if (!info.mint) return;
    checkFaucet(connection, new PublicKey(info.mint)).then((s) => !stop && setStatus(s));
    return () => {
      stop = true;
    };
  }, [connection, info.mint]);

  const mint = async () => {
    if (!info.mint || !sendTransaction) return;
    setBusy(true);
    setError(null);
    setSig(null);
    try {
      const me = new PublicKey(owner);
      const tx = new Transaction().add(...faucetMintIxs(new PublicKey(info.mint), me));
      tx.feePayer = me;
      const bh = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = bh.blockhash;
      // The faucet key signs mint_to in this tab; the wallet signs and pays.
      const signature = await sendTransaction(tx, connection, { signers: [faucetKeypair()] });
      const conf = await connection.confirmTransaction({ signature, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }, "confirmed");
      if (conf.value.err) throw new Error(`the mint failed on Solana: ${JSON.stringify(conf.value.err)}`);
      setSig(signature);
      onMinted();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const problem = status ? faucetProblem(status) : null;
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={mint} disabled={busy || !!problem || !status || !sendTransaction} aria-busy={busy}>
          <Coins aria-hidden className="size-3.5" /> {busy ? "Minting…" : `Get ${formatUsdcAmount(Number(FAUCET_AMOUNT) / 1e6)} test USDC`}
        </Button>
        {sig ? (
          <ExtLink href={baseTxExplorer(sig, info.cluster)} className="num text-[11px] text-fg-muted">
            {shortAddr(sig, 6, 4)} <ExternalLink aria-hidden className="inline size-3 align-[-1px]" />
          </ExtLink>
        ) : null}
      </div>
      {problem ? (
        <p role="alert" className="border border-warn/30 bg-warn-deep px-2 py-1.5 text-[11px] text-warn">
          {problem}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="border border-loss/30 bg-loss-deep px-2 py-1.5 text-[11px] break-words whitespace-pre-wrap text-loss">
          {error}
        </p>
      ) : null}
      <p className="text-[11px] leading-4 text-fg-dim">
        The mint authority is a throwaway keypair committed in this repo ({shortAddr(faucetAuthority().toBase58())}) and loaded into this page, because co-signing a mint in a browser means shipping the
        key. All it can do is mint this one worthless devnet token: it is not the round admin, not the program upgrade authority, and it holds nothing. Your wallet pays the fee and the rent for your own
        token account.
      </p>
    </div>
  );
}

export function TryItLive({ context }: { context: "landing" | "back" }) {
  const { info } = useRoundInfo();
  const [identity, setIdentity] = useSharedIdentity();
  const owner = identityOwner(identity);
  const token = identityToken(identity);
  const funds = useWalletFunds(info, owner, token);
  const authors = useAuthors(info);
  const licenses = useWalletLicenses(info, owner, token, authors, 5000);

  if (!info)
    return (
      <Panel aria-label="Try it live on devnet">
        <PanelHeader title="Try it live on devnet" meta="loading" />
        <div className="space-y-2 p-3" aria-busy="true">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-24 w-full" />
        </div>
      </Panel>
    );
  if (info.cluster !== "devnet" || !info.round || !info.mint)
    return (
      <Panel aria-label="Try it live on devnet">
        <PanelHeader title="Try it live on devnet" meta={info.cluster} />
        <p className="px-3 py-4 text-xs leading-5 text-fg-muted">
          {info.cluster === "devnet"
            ? "No devnet round is configured for this build, so there is nothing to back yet. The Arena shows the last round that was."
            : "This build points at a local round, where the flow runs through the local server instead. The published site at devnet is the one a visitor can use from a browser wallet."}
        </p>
      </Panel>
    );

  const hasSol = (funds.sol ?? 0) >= SOL_FOR_BACKING;
  const hasUsdc = (funds.usdcL1 ?? 0n) > 0n || (funds.usdcEr ?? 0n) > 0n;
  const licence = licenses.rows.find((r) => r.view?.active && !r.view.scrubbed) ?? licenses.rows[0] ?? null;
  const hasLicence = !!licence;

  // Four steps the visitor completes; the fifth is what they get for it, and
  // opens as soon as they hold a licence.
  const done = [!!owner, !!owner && hasSol, !!owner && hasUsdc, hasLicence];
  const firstOpen = done.findIndex((d) => !d);
  const stateOf = (i: number): State => (i >= done.length ? (hasLicence ? "now" : "later") : done[i] ? "done" : i === firstOpen ? "now" : "later");
  const completed = done.filter(Boolean).length;

  return (
    <Panel aria-label="Try it live on devnet">
      <PanelHeader title="Try it live on devnet" meta={`${completed}/${done.length} · round ${info.roundId ?? "--"}`} />
      <p className="border-b border-edge px-3 py-2 text-xs leading-5 text-fg-muted">
        Every button here sends a real transaction to Solana devnet from your own wallet. The USDC is a test mint with no value and the SOL is devnet SOL, so nothing here costs anything real — but the
        program, the rollup and the trades are the live ones.
      </p>
      <ol>
        <Step n={1} state={stateOf(0)} title="Connect a wallet" cost="free">
          {owner ? (
            <p className="num text-[11px] text-fg-dim">
              {shortAddr(owner, 6, 6)}
              {token ? " · signed in to the TEE" : " · sign in to the TEE below to read your own accounts"}
            </p>
          ) : null}
          <WalletPicker info={info} identity={identity} onChange={setIdentity} />
        </Step>

        <Step n={2} state={stateOf(1)} title="Get devnet SOL" cost="free">
          <p>
            {owner ? (
              <>
                <span className="num text-fg">{formatSol(funds.sol)}</span> SOL in your wallet.{" "}
              </>
            ) : null}
            The whole path costs about {SOL_NEEDED} SOL, nearly all of it rent for accounts you own. The faucet hands out far more than that.
          </p>
          <a
            href={SOL_FAUCET}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex min-h-9 items-center gap-2 rounded-[2px] border border-edge-strong bg-surface-2 px-3 font-mono text-xs tracking-[0.06em] text-fg uppercase transition-colors duration-150 hover:border-fg-dim"
          >
            <Wallet aria-hidden className="size-3.5" /> faucet.solana.com <ExternalLink aria-hidden className="size-3" />
          </a>
        </Step>

        <Step n={3} state={stateOf(2)} title="Get test USDC" cost="0.002 SOL of rent">
          {owner ? (
            <>
              <p>
                <span className="num text-fg">{funds.usdcL1 === null ? "--" : formatUsdcAmount(Number(funds.usdcL1) / 1e6)}</span> test USDC in your wallet
                {funds.deposited && funds.usdcEr !== null ? <> · {formatUsdcAmount(Number(funds.usdcEr) / 1e6)} already inside the rollup</> : null}
              </p>
              <FaucetButton info={info} owner={owner} onMinted={funds.refresh} />
            </>
          ) : (
            <p className="text-fg-dim">
              1,000 test USDC, minted to your wallet by a throwaway key this site ships. The round&apos;s USDC is a test mint with no value, so there is nothing to guard. Connect a wallet first.
            </p>
          )}
        </Step>

        <Step n={4} state={stateOf(3)} title="Back a sealed strategy" cost="your margin + 0.014 SOL of rent">
          <p>
            Pick an author and put up margin. The crank runs their private bytecode against your own book every tick, and you never receive the code. Five wallet prompts: open_license and
            delegate_license on Solana, the deposit that moves your test USDC into the rollup, then activate_license and schedule_license_tick inside the enclave.
          </p>
          {hasLicence && licence ? (
            <p className="text-gain">
              You hold a licence on {licence.authorName}
              {licence.view ? ` · ${licence.view.active ? "active" : "opened, not activated yet"}` : " · opened on Solana"}.
            </p>
          ) : context === "landing" ? (
            <Link
              href="/back"
              className="inline-flex min-h-9 items-center gap-2 rounded-[2px] border border-edge-strong bg-surface-2 px-3 font-mono text-xs tracking-[0.06em] text-fg uppercase transition-colors duration-150 hover:border-fg-dim"
            >
              Browse sealed strategies
            </Link>
          ) : (
            <p className="text-fg-dim">Choose a row in the table and use the panel beside it.</p>
          )}
        </Step>

        <Step n={5} state={stateOf(4)} title="Watch it, then check nobody else can read it" cost="free">
          <p>Your licence&apos;s book is readable by exactly two wallets: yours and the author&apos;s. The Arena shows the public side; the Proof page runs the read attacks against a live account.</p>
          <div className="flex flex-wrap gap-2">
            <Link
              href="/arena"
              className="inline-flex min-h-9 items-center rounded-[2px] border border-edge-strong bg-surface-2 px-3 font-mono text-xs tracking-[0.06em] text-fg uppercase transition-colors duration-150 hover:border-fg-dim"
            >
              Arena
            </Link>
            <Link
              href="/proof"
              className="inline-flex min-h-9 items-center rounded-[2px] border border-edge-strong bg-surface-2 px-3 font-mono text-xs tracking-[0.06em] text-fg uppercase transition-colors duration-150 hover:border-fg-dim"
            >
              Proof
            </Link>
          </div>
        </Step>
      </ol>
      {funds.error ? (
        <p className="border-t border-edge px-3 py-2 text-[11px] text-fg-dim">
          Reading your balances from {info.endpoints.base} failed: {funds.error}. Retrying.
        </p>
      ) : null}
    </Panel>
  );
}
