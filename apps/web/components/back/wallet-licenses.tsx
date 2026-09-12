"use client";
/**
 * The connected wallet's own licences, read from the TEE with its auth token.
 *
 * The point of the panel is what is *not* in it for anyone else: the same
 * `getMultipleAccounts` without this token returns null for every one of these
 * accounts, because the License permission has exactly two members, the buyer
 * and the author. The read line under the cards shows the request that produced
 * the numbers above it, with the token redacted.
 */
import { useState } from "react";
import Link from "next/link";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { useWallet } from "@solana/wallet-adapter-react";
import type { BackerLicense, PublicRoundInfo } from "../../lib/api-types";
import type { MarketView, RoundView } from "../../lib/chain";
import { settleLicenseIxs } from "../../lib/license-ix";
import { erTxExplorer } from "../../lib/explorer";
import { formatInt, formatMs, shortAddr } from "../../lib/format";
import { tokenUrl } from "../../lib/tee-auth";
import { identityOwner, identityToken, useSharedIdentity } from "../../lib/wallet-identity";
import type { AuthorMeta, WalletLicenses } from "../../lib/wallet-hooks";
import { WalletPicker } from "../studio/identity";
import { Button, ExtLink, Panel, PanelHeader, Skeleton } from "../ui";
import { LicenseCard } from "./my-licenses";

/** Close the licence yourself: settle_license takes any payer, so the buyer can run it. */
function SettleButton({ info, round, buyer, author, token }: { info: PublicRoundInfo; round: RoundView; buyer: string; author: string; token: string }) {
  const wallet = useWallet();
  const [busy, setBusy] = useState(false);
  const [sig, setSig] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const settle = async () => {
    if (!wallet.signTransaction || !info.round) return;
    setBusy(true);
    setError(null);
    try {
      const me = new PublicKey(buyer);
      const tee = new Connection(tokenUrl(info.endpoints.tee, token), { commitment: "confirmed" });
      const tx = new Transaction().add(...settleLicenseIxs(new PublicKey(info.round), new PublicKey(round.mint), me, new PublicKey(author), round.nMarkets));
      tx.feePayer = me;
      tx.recentBlockhash = (await tee.getLatestBlockhash()).blockhash;
      const signed = await wallet.signTransaction(tx);
      const signature = await tee.sendRawTransaction(signed.serialize(), { skipPreflight: true });
      const conf = await tee.confirmTransaction(signature, "confirmed");
      if (conf.value.err) throw new Error(`settle_license failed on the rollup: ${JSON.stringify(conf.value.err)}`);
      setSig(signature);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-edge px-3 py-2">
      <Button onClick={settle} disabled={busy} aria-busy={busy}>
        {busy ? "Settling…" : "Settle this licence"}
      </Button>
      <span className="text-[11px] text-fg-dim">
        The round is settling. settle_license is permissionless: closing it yourself pays the author their accrued fees and returns the rest of your margin to your rollup balance.
      </span>
      {sig ? (
        <ExtLink href={erTxExplorer(sig, info.cluster, info.endpoints.tee)} className="num text-[11px] text-fg-muted">
          {shortAddr(sig, 6, 4)}
        </ExtLink>
      ) : null}
      {error ? (
        <p role="alert" className="w-full text-[11px] break-words whitespace-pre-wrap text-loss">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function WalletLicenses({ info, round, licenses, authors, markets }: { info: PublicRoundInfo; round: RoundView | null; licenses: WalletLicenses; authors: AuthorMeta[]; markets: (MarketView | null)[] }) {
  const [identity, setIdentity] = useSharedIdentity();
  const owner = identityOwner(identity);
  const token = identityToken(identity);
  const settling = round?.status === "settling";

  const body = () => {
    if (!owner) return <p className="px-3 py-8 text-center text-sm text-fg-dim">Connect a wallet to see the licences it owns in this round.</p>;
    if (licenses.status === "loading" && !licenses.rows.length)
      return (
        <div className="space-y-2 p-3" aria-busy="true">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-16 w-full" />
        </div>
      );
    if (!licenses.rows.length)
      return (
        <div className="px-3 py-8 text-center">
          <p className="text-sm text-fg-muted">This wallet holds no licence in round {info.roundId ?? "--"}.</p>
          <p className="mt-1 text-xs text-fg-dim">Pick a sealed strategy above and back it. Its trades on your margin appear here every tick.</p>
        </div>
      );
    if (!token)
      return (
        <div className="space-y-3 px-3 py-5">
          <p className="text-sm text-fg-muted">
            {formatInt(licenses.rows.length)} licence{licenses.rows.length === 1 ? "" : "s"} found on Solana — that they exist is public, what is in them is not. Sign the TEE login challenge to read
            your own books.
          </p>
          <WalletPicker info={info} identity={identity} onChange={setIdentity} />
        </div>
      );
    return (
      <div>
        {licenses.rows.map((r) => {
          const l: BackerLicense = { author: r.author, authorName: r.authorName, license: r.license, scheduled: null, view: r.view, error: r.error ?? (r.delegated ? null : "Opened on Solana but not delegated to the rollup yet.") };
          return (
            <div key={r.license}>
              <LicenseCard l={l} markets={markets} names={info.markets} info={info} />
              {settling && round && r.view?.active && !r.view.scrubbed ? <SettleButton info={info} round={round} buyer={owner} author={r.author} token={token} /> : null}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <Panel aria-label="Your licences">
      <PanelHeader title="Your licences · readable by you and the author, nobody else" meta={owner ? shortAddr(owner, 6, 6) : "no wallet"} />
      {body()}
      {owner && licenses.endpoint ? (
        <div className="num flex flex-wrap gap-x-4 gap-y-0.5 border-t border-edge px-3 py-1.5 text-[11px] text-fg-dim">
          <span>getMultipleAccounts · {formatInt(authors.length)} License PDAs</span>
          <span className="truncate">{licenses.endpoint}</span>
          <span>
            {licenses.ms === null ? "--" : formatMs(licenses.ms)} · {formatInt(licenses.readable)} returned
          </span>
        </div>
      ) : null}
      <p className="border-t border-edge px-3 py-2 text-[11px] leading-4 text-fg-dim">
        The same request without your token returns null for every one of these accounts: the License permission lists two members, you and the author. Run that check yourself on{" "}
        <Link href="/proof" className="underline decoration-edge-strong underline-offset-4 hover:text-fg">
          Proof
        </Link>
        . The author sees your book on their strategy; you never see their code.
      </p>
    </Panel>
  );
}
