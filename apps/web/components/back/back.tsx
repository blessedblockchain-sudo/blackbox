"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { MotionConfig } from "framer-motion";
import type { BackerLicense, PublicRoundInfo } from "../../lib/api-types";
import type { EntrantView, RoundView, ScoreboardView } from "../../lib/chain";
import { useLiveRound, useRoundInfo } from "../../lib/hooks";
import { noRoundDetail, roundInfoError } from "../../lib/messages";
import { formatBps, formatInt, returnPct, shortAddr } from "../../lib/format";
import { Panel, PanelHeader, Skeleton } from "../ui";
import { phaseLabel } from "../arena/round-header";
import { AuthorTable, type AuthorRow } from "./author-table";
import { BackPanel } from "./back-panel";
import { JobPanel } from "./job-steps";
import { MyLicenses } from "./my-licenses";
import { useBackState } from "./use-back-state";

/** Why nobody can back anything right now (null while the round is live). */
function backingGate(round: RoundView | null): string | null {
  if (!round) return "Waiting for the round on the TEE.";
  if (round.status === "live") return round.durationTicks - round.tick < 20 ? "The round is about to end. Back a strategy in the next round." : null;
  if (round.status === "open" || round.status === "created") return "Backing opens when the round goes live: activation and the crank task need a live round.";
  return "This round has ended. Its licenses settle with it: fees to authors, the rest back to backers.";
}

function buildRows(info: PublicRoundInfo, sb: ScoreboardView | null, entrants: Record<string, EntrantView>, backer: string | null, mine: BackerLicense[]): AuthorRow[] {
  const meta = new Map(info.entrants.map((e) => [e.owner, e]));
  const backersBy = new Map<string, string[]>();
  for (const l of info.licenses) {
    const list = backersBy.get(l.author) ?? [];
    const n = l.name || shortAddr(l.buyer);
    if (!list.includes(n)) list.push(n);
    backersBy.set(l.author, list);
  }
  const youBack = new Set(mine.filter((l) => l.view?.active && !l.view.scrubbed).map((l) => l.author));
  const owners = [...new Set([...(sb?.entries.map((e) => e.owner) ?? []), ...info.entrantOwners, ...info.entrants.map((e) => e.owner)])].filter((o) => o !== backer);
  const rows = owners.map((owner, i): AuthorRow => {
    const ent = entrants[owner];
    const e = sb?.entries.find((x) => x.owner === owner) ?? null;
    const m = meta.get(owner);
    const deposited = e?.deposited ?? ent?.deposited ?? null;
    return {
      owner,
      name: m?.name || shortAddr(owner),
      bot: !!m?.bot,
      external: !!m?.external,
      index: e?.index ?? ent?.index ?? i,
      feePriceBps: ent ? ent.feePriceBps : null,
      licenseCount: ent ? ent.licenseCount : null,
      strategyVersion: ent?.strategyVersion ?? null,
      settled: !!ent?.settled,
      equity: e ? e.equity : null,
      returnPct: e && deposited ? returnPct(e.equity, deposited) : null,
      alive: e ? e.alive : ent ? ent.alive : null,
      backers: backersBy.get(owner) ?? [],
      youBack: youBack.has(owner),
    };
  });
  return rows.sort((a, b) => (b.feePriceBps ?? -1) - (a.feePriceBps ?? -1) || (b.equity ?? -Infinity) - (a.equity ?? -Infinity) || a.index - b.index);
}

function Problem({ title, detail }: { title: string; detail: string }) {
  return (
    <Panel className="px-4 py-10">
      <div className="mx-auto max-w-xl">
        <div className="label-caps !text-warn">{title}</div>
        <p className="mt-2 text-sm text-fg-muted">{detail}</p>
      </div>
    </Panel>
  );
}

function Intro({ info, round }: { info: PublicRoundInfo; round: RoundView | null }) {
  return (
    <header className="border border-edge bg-surface px-4 py-3">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h1 className="font-mono text-lg font-medium tracking-tight">Back a strategy, blind</h1>
        <span className="num text-xs text-fg-dim">
          Round {info.roundId ?? "--"} · {phaseLabel(round, info)} · {info.cluster}
          {round ? ` · blind prices ${formatBps(round.licenseFeeMinBps, { decimals: 0 })} to ${formatBps(round.licenseFeeMaxBps, { decimals: 0 })}` : ""}
        </span>
      </div>
      <p className="mt-2 max-w-[92ch] text-sm leading-6 text-fg-muted">
        Backing runs an author&apos;s sealed strategy on your own margin: every tick the crank executes their private bytecode inside the TEE against your own License book, which only you and the author can
        read. You never see the code, and the fee (bps of every trade&apos;s notional, paid to the author at settlement) is locked at the author&apos;s blind price, which the TEE sets from their private Sharpe
        ratio.
      </p>
      <p className="mt-1 text-xs text-fg-dim">
        Your own fills still show what the strategy does with your money.{" "}
        <Link href="/disclosures#item-24" className="underline decoration-edge-strong underline-offset-4 transition-colors duration-150 hover:text-fg hover:decoration-fg-dim">
          Disclosure 24
        </Link>
      </p>
    </header>
  );
}

export function Back() {
  const { info, error: infoError } = useRoundInfo();
  const live = useLiveRound(info);
  const local = !!info?.localRoutes && !!info?.round;
  const back = useBackState(local);
  const [selected, setSelected] = useState<string | null>(null);

  const backer = back.data?.backer.owner ?? null;
  const mine = back.data?.licenses;
  const rows = useMemo(() => (info ? buildRows(info, live.scoreboard, live.entrants, backer, mine ?? []) : []), [info, live.scoreboard, live.entrants, backer, mine]);

  if (!info) {
    return infoError ? (
      <Problem title="Round info unavailable" detail={roundInfoError(infoError)} />
    ) : (
      <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading">
        <Skeleton className="h-[112px] w-full" />
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
          <Skeleton className="h-[420px]" />
          <Skeleton className="h-[320px]" />
        </div>
      </div>
    );
  }
  if (info.source === "none" || !info.round) {
    return (
      <Problem title="No round configured" detail={noRoundDetail(info.cluster)} />
    );
  }

  const round = live.round;
  const sealed = live.scoreboardSealed || round?.mode === "dark";
  const gate = backingGate(round);
  const selectedRow = rows.find((r) => r.owner === selected) ?? null;
  const latestJob = back.data?.jobs[0] ?? null;

  return (
    <MotionConfig reducedMotion="user">
      <div className="flex flex-col gap-3">
        <Intro info={info} round={round} />
        {/* grid-cols-1 = minmax(0, 1fr): the wide table scrolls inside its panel instead of widening the page. */}
        <div className="grid grid-cols-1 items-start gap-3 xl:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
          <Panel aria-label="Strategies" className="min-w-0">
            <PanelHeader
              title={`Sealed strategies · ${formatInt(rows.length)}`}
              meta={sealed ? "dark round · the blind price is the only quality signal" : "by blind price, then equity"}
            />
            {rows.length ? (
              <AuthorTable rows={rows} round={round} sealed={sealed} selected={selected} onSelect={setSelected} gate={gate} />
            ) : live.status === "error" || live.status === "missing" ? (
              <p className="px-3 py-8 text-sm text-fg-dim">Cannot read the round from the TEE: {live.error ?? "no data"}. Retrying.</p>
            ) : round ? (
              <p className="px-3 py-8 text-center text-sm text-fg-dim">No entrants yet. Strategies appear here as soon as authors join the round.</p>
            ) : (
              <div className="space-y-2 p-3" aria-busy="true">
                {Array.from({ length: 6 }, (_, i) => (
                  <Skeleton key={i} className="h-9 w-full" />
                ))}
              </div>
            )}
          </Panel>
          <div className="flex min-w-0 flex-col gap-3">
            <BackPanel info={info} round={round} author={selectedRow} gate={gate} local={local} back={back} markets={live.markets} />
            {latestJob ? <JobPanel job={latestJob} /> : null}
          </div>
        </div>
        {local ? <MyLicenses state={back} markets={live.markets} names={info.markets} info={info} /> : null}
      </div>
    </MotionConfig>
  );
}
