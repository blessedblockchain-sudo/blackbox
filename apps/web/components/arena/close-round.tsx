"use client";
/**
 * Closing a round from the browser.
 *
 * BLACKBOX has no privileged keeper. `tick_clock`, `settle_license`,
 * `settle_entrant`, `undelegate_entrant`, `rank_round`, `pay_prizes` and
 * `close_round` all take a bare `Signer` on chain, so when a round's clock runs
 * out any wallet can walk it through settlement and collect nothing for doing
 * it. This panel is that wallet being a visitor.
 *
 * It appears only when there is something to do: the round is settling, or it
 * is live with its clock already past the end. Everything else is a no-op.
 */
import { useMemo, useState } from "react";
import { Connection, PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import type { JobStep, PublicRoundInfo, StepLayer } from "../../lib/api-types";
import { decodeAccount, scoreboardPda, toScoreboardView, type RoundView } from "../../lib/chain";
import { settleLicenseIxs } from "../../lib/license-ix";
import { closeRoundIxs, payPrizesIxs, rankRoundIx, recordHallIxs, settleEntrantIxs, tickClockIx, undelegateEntrantIx } from "../../lib/settle-ix";
import { baseTxExplorer, erTxExplorer } from "../../lib/explorer";
import { formatInt, shortAddr } from "../../lib/format";
import { tokenUrl } from "../../lib/tee-auth";
import { identityOwner, identityToken, useSharedIdentity } from "../../lib/wallet-identity";
import { Badge, Button, Dot, ExtLink, Panel, PanelHeader } from "../ui";
import { rpcConnection } from "../../lib/rpc";

/** A licence somebody opened on this round, from the round file or the public chat. */
export interface OpenLicence {
  buyer: string;
  author: string;
  source: "round file" | "round chat";
}

const SOL_TO_CLOSE = 0.02;

export function CloseRound({ info, round, owners, licences }: { info: PublicRoundInfo; round: RoundView; owners: string[]; licences: OpenLicence[] }) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [identity] = useSharedIdentity();
  const owner = identityOwner(identity);
  const token = identityToken(identity);
  const [steps, setSteps] = useState<JobStep[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // The clock is permissionless but bounded by wall time on chain, so it can
  // only be pushed as far as the round has actually run.
  const secondsIn = round.startedAt > 0 ? Date.now() / 1000 - round.startedAt : 0;
  const earnedTicks = Math.floor((secondsIn * 1000) / Math.max(1, round.tickIntervalMs));
  const clockBehind = Math.max(0, Math.min(round.durationTicks, earnedTicks) - round.tick);
  const expired = round.startedAt > 0 && earnedTicks >= round.durationTicks;
  const needsClock = round.status === "live" && expired;
  const needsSettle = round.status === "settling";
  const relevant = needsClock || needsSettle;

  const plan = useMemo(() => {
    const s: [string, string, StepLayer][] = [];
    if (needsClock) s.push(["clock", `tick_clock: run out the last ${formatInt(clockBehind)} ticks and freeze trading`, "er"]);
    if (licences.length) s.push(["licences", `settle_license × ${licences.length}: accrued fees to the authors, the rest back to the backers`, "er"]);
    s.push(["entrants", `settle_entrant × ${owners.length}: close every book at the final mark and scrub the private bodies`, "er"]);
    s.push(["undelegate", `undelegate_entrant × ${owners.length}: release the entrants back to Solana`, "er"]);
    s.push(["rank", "rank_round: final ranks onto the scoreboard", "er"]);
    s.push(["prizes", "pay_prizes: the pot to the top three", "er"]);
    s.push(["close", "close_round: commit the round and scoreboard back to Solana", "er"]);
    s.push(["hall", `record_hall × ${owners.length}: write the results into the Hall of Fame`, "l1"]);
    return s;
  }, [needsClock, clockBehind, licences.length, owners.length]);

  if (!relevant) return null;

  const running = !!steps && !done && !error;
  const reason =
    !owner
      ? "Connect a wallet to close the round."
      : !token
        ? "Sign in to the TEE: the rollup will not take a transaction without your auth token."
        : !wallet.signTransaction || !wallet.sendTransaction
          ? "This wallet cannot sign transactions."
          : running
            ? "Closing the round."
            : null;

  const run = async () => {
    if (!owner || !token || !info.round || !round.mint || !wallet.signTransaction) return;
    const me = new PublicKey(owner);
    const r = new PublicKey(info.round);
    const mint = new PublicKey(round.mint);
    const tee = rpcConnection(tokenUrl(info.endpoints.tee, token), { commitment: "confirmed" });
    const n = round.nMarkets;
    setError(null);
    setDone(false);

    const live: JobStep[] = plan.map(([key, label, layer]) => ({ key, label, layer, status: "pending" }));
    const commit = () => setSteps(live.map((s) => ({ ...s })));
    commit();

    const sendEr = async (ixs: TransactionInstruction[]) => {
      const tx = new Transaction().add(...ixs);
      tx.feePayer = me;
      tx.recentBlockhash = (await tee.getLatestBlockhash()).blockhash;
      const signed = await wallet.signTransaction!(tx);
      const sig = await tee.sendRawTransaction(signed.serialize(), { skipPreflight: true });
      const conf = await tee.confirmTransaction(sig, "confirmed");
      if (conf.value.err) throw new Error(`rejected by the rollup: ${JSON.stringify(conf.value.err)} (${sig})`);
      return sig;
    };
    const sendL1 = async (ixs: TransactionInstruction[]) => {
      const tx = new Transaction().add(...ixs);
      tx.feePayer = me;
      const bh = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = bh.blockhash;
      const sig = await wallet.sendTransaction(tx, connection);
      const conf = await connection.confirmTransaction({ signature: sig, ...bh }, "confirmed");
      if (conf.value.err) throw new Error(`rejected by Solana: ${JSON.stringify(conf.value.err)} (${sig})`);
      return sig;
    };

    const step = async (key: string, fn: () => Promise<{ sig?: string; detail?: string; skipped?: boolean } | void>) => {
      const s = live.find((x) => x.key === key);
      if (!s) return;
      s.status = "running";
      commit();
      const t0 = Date.now();
      try {
        const res = (await fn()) || {};
        s.ms = Date.now() - t0;
        if (res.sig) {
          s.sig = res.sig;
          s.explorer = s.layer === "er" ? erTxExplorer(res.sig, info.cluster, info.endpoints.tee) : baseTxExplorer(res.sig, info.cluster);
        }
        if (res.detail) s.detail = res.detail;
        s.status = res.skipped ? "skipped" : "done";
      } catch (e) {
        s.ms = Date.now() - t0;
        s.status = "error";
        s.detail = e instanceof Error ? e.message : String(e);
        throw e;
      } finally {
        commit();
      }
    };

    // Each of these tolerates work somebody else already did: the instructions
    // are idempotent enough that a second caller just loses the race.
    const eachOf = async <T,>(items: T[], fn: (item: T) => Promise<string>): Promise<{ sig?: string; detail: string }> => {
      let last: string | undefined;
      let ok = 0;
      const failed: string[] = [];
      for (const item of items) {
        try {
          last = await fn(item);
          ok++;
        } catch (e) {
          failed.push(e instanceof Error ? e.message.slice(0, 90) : String(e).slice(0, 90));
        }
      }
      if (!ok && failed.length) throw new Error(failed[0]);
      return { sig: last, detail: `${ok}/${items.length} sent${failed.length ? ` · ${failed.length} already done or rejected` : ""}` };
    };

    try {
      await step("clock", async () => {
        // 12 tick_clock calls per transaction; the on-chain wall-clock bound
        // makes the extras no-ops, so overshooting is free.
        let sig: string | undefined;
        for (let sent = 0; sent < clockBehind; sent += 12) sig = await sendEr(Array.from({ length: Math.min(12, clockBehind - sent) }, () => tickClockIx(r)));
        return { sig, detail: `${formatInt(clockBehind)} ticks` };
      });
      await step("licences", () => eachOf(licences, (l) => sendEr(settleLicenseIxs(r, mint, new PublicKey(l.buyer), new PublicKey(l.author), n, me))));
      // Losers first, as the runner does it: profits then come out of their
      // losses rather than out of the house bankroll.
      await step("entrants", () => eachOf([...owners].reverse(), (o) => sendEr(settleEntrantIxs(r, mint, new PublicKey(o), n, me))));
      await step("undelegate", () => eachOf(owners, (o) => sendEr([undelegateEntrantIx(r, new PublicKey(o), me)])));
      await step("rank", async () => ({ sig: await sendEr([rankRoundIx(r, me)]) }));
      await step("prizes", async () => {
        // pay_prizes checks its remaining accounts against the ranks the
        // program just wrote, so read them back rather than trusting the sort
        // this page happened to render.
        const acc = await tee.getAccountInfo(scoreboardPda(r), "confirmed");
        const sb = acc ? toScoreboardView(decodeAccount("scoreboard", acc.data)) : null;
        const ranked = (sb?.entries ?? []).filter((e) => e.rank > 0).sort((a, b) => a.rank - b.rank).slice(0, 3);
        const winners = (ranked.length ? ranked.map((e) => e.owner) : owners.slice(0, 3)).map((o) => new PublicKey(o));
        return { sig: await sendEr(payPrizesIxs(r, mint, winners, me)), detail: `${winners.length} paid` };
      });
      await step("close", async () => ({ sig: await sendEr(closeRoundIxs(r, n, me)) }));
      await step("hall", () => eachOf(owners, (o) => sendL1(recordHallIxs(r, new PublicKey(o), me))));
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const blocked = needsSettle && round.openLicenses > licences.length;

  return (
    <Panel aria-label="Close the round">
      <PanelHeader
        title="This round is ready to be closed"
        meta={
          <span className="flex items-center gap-2">
            <Dot tone="warn" pulse />
            no keeper · anyone can do this
          </span>
        }
      />
      <div className="flex flex-col gap-3 px-3 py-3">
        <p className="max-w-[70ch] text-xs leading-5 text-fg-muted">
          {needsClock
            ? `Round ${String(round.id).padStart(2, "0")} has run its full ${formatInt(round.durationTicks)} ticks.`
            : `Round ${String(round.id).padStart(2, "0")} is settling.`}{" "}
          Every instruction left takes a plain signer — there is no admin key on this path and nothing is paid to whoever calls it. Run it with your own wallet
          and the books close, the pot pays out, the private bodies are scrubbed, and the round commits back to Solana. Costs about {SOL_TO_CLOSE} devnet SOL in
          fees.
        </p>

        <ol className="divide-y divide-edge border border-edge">
          {(steps ?? plan.map(([key, label, layer]): JobStep => ({ key, label, layer, status: "pending" }))).map((s) => (
            <li key={s.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2.5 py-2 text-xs">
              <Dot tone={s.status === "done" ? "gain" : s.status === "error" ? "loss" : s.status === "running" ? "warn" : "dim"} pulse={s.status === "running"} />
              <span className={s.status === "pending" ? "text-fg-dim" : "text-fg-muted"}>{s.label}</span>
              <Badge tone="dim">{s.layer === "er" ? "rollup" : "solana"}</Badge>
              <span className="num ml-auto flex items-center gap-3 text-fg-dim">
                {s.detail ? <span className="max-w-[40ch] truncate" title={s.detail}>{s.detail}</span> : null}
                {s.ms ? <span>{formatInt(s.ms)} ms</span> : null}
                {s.explorer && s.sig ? <ExtLink href={s.explorer}>{shortAddr(s.sig)}</ExtLink> : null}
              </span>
            </li>
          ))}
        </ol>

        {blocked ? (
          <p className="text-xs leading-5 text-warn">
            The round counts {formatInt(round.openLicenses)} open licences and this page can only see {formatInt(licences.length)} of them. The unseen ones have
            to settle before `close_round` will run, so expect the last step to fail until their backers settle from /back.
          </p>
        ) : null}
        {error ? <p className="text-xs leading-5 text-loss">{error}</p> : null}
        {done ? <p className="text-xs leading-5 text-gain">Round closed. The scoreboard, final ranks and published strategy hashes are on Solana now.</p> : null}

        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" onClick={run} disabled={!!reason}>
            {running ? "Closing…" : done ? "Close again" : "Close the round"}
          </Button>
          {reason ? <span className="text-xs text-fg-dim">{reason}</span> : null}
          {licences.length ? <span className="text-xs text-fg-dim">{formatInt(licences.length)} licences found ({[...new Set(licences.map((l) => l.source))].join(", ")})</span> : null}
        </div>
      </div>
    </Panel>
  );
}
