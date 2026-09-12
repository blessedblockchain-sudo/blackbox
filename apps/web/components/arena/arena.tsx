"use client";
import { useMemo } from "react";
import { useChat, useHistory, useLiveRound, useRoundInfo } from "../../lib/hooks";
import { returnPct, shortAddr, formatInt } from "../../lib/format";
import { solvency } from "../../lib/solvency";
import { PROGRAM_ID, licencesFromChat, type RoundView } from "../../lib/chain";
import { noRoundDetail, roundInfoError } from "../../lib/messages";
import { baseAddressExplorer, erAddressExplorer } from "../../lib/explorer";
import type { PublicRoundInfo } from "../../lib/api-types";
import { RoundHeader } from "./round-header";
import { MarketStrip } from "./market-strip";
import { EntrantGrid } from "./entrant-grid";
import type { TileData } from "./blackbox-tile";
import { ExtLink, Panel, PanelHeader, Skeleton } from "../ui";
import { BoxMark } from "../site-nav";
import { RoundChat } from "./round-chat";
import { CloseRound, type OpenLicence } from "./close-round";

export function Arena() {
  const { info, error: infoError } = useRoundInfo();
  const live = useLiveRound(info);
  const history = useHistory(info, live);
  const chat = useChat(info);

  const tiles = useMemo<TileData[]>(() => {
    if (!info) return [];
    const names = new Map(info.entrants.map((e) => [e.owner, e]));
    const sb = live.scoreboard;
    const owners: string[] = sb ? sb.entries.map((e) => e.owner) : [...new Set([...info.entrantOwners, ...info.entrants.map((e) => e.owner)])];
    const rows: TileData[] = owners.map((owner, i) => {
      const e = sb?.entries.find((x) => x.owner === owner) ?? null;
      const ent = live.entrants[owner];
      const meta = names.get(owner);
      const deposited = e?.deposited ?? ent?.deposited ?? null;
      return {
        owner,
        name: meta?.name || shortAddr(owner),
        index: e?.index ?? ent?.index ?? i,
        rank: null,
        equity: e ? e.equity : null,
        deposited,
        returnPct: e && deposited ? returnPct(e.equity, deposited) : null,
        trades: e ? e.trades : null,
        alive: e ? e.alive : ent ? ent.alive : null,
        settled: !!ent?.settled,
        strategyVersion: ent?.strategyVersion ?? null,
        strategyHash: ent?.strategyHash ?? "",
        feePriceBps: ent ? ent.feePriceBps : null,
        licenseCount: ent ? ent.licenseCount : null,
        bot: !!meta?.bot,
        history: history.store.equity(owner, 160),
      };
    });
    if (sb) {
      const finalRank = sb.finalized && sb.entries.some((x) => x.rank > 0);
      rows.sort((a, b) => (b.equity ?? -Infinity) - (a.equity ?? -Infinity) || a.index - b.index);
      rows.forEach((r, i) => {
        const e = sb.entries.find((x) => x.owner === r.owner);
        r.rank = finalRank && e && e.rank > 0 ? e.rank : i + 1;
      });
      if (finalRank) rows.sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
    } else {
      rows.sort((a, b) => a.index - b.index);
    }
    return rows;
    // history.version drives recomputation when new samples land
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info, live.scoreboard, live.entrants, history.version]);

  // Licences to settle at the end: the ones the round file knows about, plus any
  // a visitor opened and announced in the public chat (see `licencesFromChat`).
  const licences = useMemo<OpenLicence[]>(() => {
    const out: OpenLicence[] = [];
    const seen = new Set<string>();
    const add = (buyer: string, author: string, source: OpenLicence["source"]) => {
      const key = `${buyer}:${author}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ buyer, author, source });
    };
    for (const l of info?.licenses ?? []) add(l.buyer, l.author, "round file");
    for (const l of licencesFromChat(chat.messages)) add(l.buyer, l.author, "round chat");
    return out;
  }, [info, chat.messages]);

  const beacon = useMemo(() => {
    const r = live.round;
    const deposits = live.scoreboard ? live.scoreboard.entries.map((e) => e.deposited) : Object.values(live.entrants).map((e) => e.deposited);
    return solvency({ deposits, vaultBalance: r?.vaultBalance ?? NaN, totalEquity: r?.totalEquity ?? NaN, pot: r?.pot ?? NaN });
  }, [live.round, live.scoreboard, live.entrants]);

  if (!info) return infoError ? <Problem title="Round info unavailable" detail={roundInfoError(infoError)} /> : <ArenaSkeleton />;
  if (info.source === "none" || !info.round) return <Problem title="No round configured" detail={noRoundDetail(info.cluster)} />;
  if (!live.round) {
    if (live.status === "error" || live.status === "missing")
      return <Problem title="Cannot read the round from the TEE" detail={`${live.error ?? "no data"}. Polling ${info.endpoints.tee} every 700 ms.`} />;
    return <ArenaSkeleton />;
  }

  const sealed = live.scoreboardSealed || live.round.mode === "dark";
  return (
    <div className="flex flex-col gap-3">
      <RoundState info={info} round={live.round} />
      <CloseRound info={info} round={live.round} owners={tiles.map((t) => t.owner)} licences={licences} />
      <RoundHeader info={info} round={live.round} solvency={beacon} latencyMs={live.latencyMs} status={live.status} />
      <MarketStrip names={info.markets} markets={live.markets} mystery={live.round.vrfReady ? live.round.mysteryMarket : null} />
      <Panel>
        <PanelHeader
          title={`Entrants · ${formatInt(tiles.length)}`}
          meta={sealed ? "dark round · equities sealed until settlement" : `sorted by equity · history ${history.source} · ${formatInt(history.samples)} ticks`}
        />
        <div className="p-2">
          {tiles.length ? (
            <EntrantGrid tiles={tiles} sealed={sealed} />
          ) : (
            <p className="px-2 py-8 text-center text-sm text-fg-dim">No entrants yet. Entrants appear here as soon as they join the round.</p>
          )}
        </div>
      </Panel>
      <RoundChat info={info} round={live.round} />
      <ArenaFooter info={info} />
    </div>
  );
}

/**
 * What the visitor is looking at when it is not a live round. A settled round
 * is the normal resting state between runs: say so, and keep showing it rather
 * than an empty page.
 */
function RoundState({ info, round }: { info: PublicRoundInfo; round: RoundView }) {
  if (round.status === "live") return null;
  const id = String(round.id).padStart(2, "0");
  const ended = round.endedAt ? new Date(round.endedAt * 1000).toLocaleString("en-US", { hour12: false, timeZone: "UTC" }) : null;
  const text =
    round.status === "settled"
      ? `No round is running on ${info.cluster} right now. This is round ${id} as it finished${ended ? ` (${ended} UTC)` : ""}: final equities, the published sha256 of each strategy, and what the books settled at. A new round appears here on its own once one is created.`
      : round.status === "settling"
        ? `Round ${id} is settling: books are closing at the final marks, licences pay their accrued fees, and private state is scrubbed before it commits to Solana.`
        : round.status === "open"
          ? `Round ${id} is open for registration. Entrants join, seal and fund their strategies; trading starts when the round goes live.`
          : `Round ${id} has been created but is not open yet.`;
  return (
    <Panel className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5">
      <span className="label-caps !text-warn">{round.status === "settled" ? "Between rounds" : round.status}</span>
      <p className="min-w-0 flex-1 text-xs text-fg-muted">{text}</p>
    </Panel>
  );
}

function ArenaFooter({ info }: { info: PublicRoundInfo }) {
  return (
    <footer className="flex flex-wrap items-center gap-x-6 gap-y-2 border border-edge bg-surface px-3 py-2.5 text-xs text-fg-dim">
      <span className="flex items-center gap-2 text-fg-muted">
        <BoxMark className="size-3.5 text-fg-muted" />
        Only the program can see inside.
      </span>
      <span className="flex flex-wrap gap-x-4 gap-y-1 font-mono sm:ml-auto">
        {info.round ? <ExtLink href={erAddressExplorer(info.round, info.cluster, info.endpoints.tee)}>Round on TEE</ExtLink> : null}
        <ExtLink href={baseAddressExplorer(PROGRAM_ID.toBase58(), info.cluster, info.endpoints.base)}>Program {shortAddr(PROGRAM_ID.toBase58())}</ExtLink>
        {info.mint ? <ExtLink href={baseAddressExplorer(info.mint, info.cluster, info.endpoints.base)}>USDC mint</ExtLink> : null}
      </span>
    </footer>
  );
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

function ArenaSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading round">
      <Skeleton className="h-[132px] w-full" />
      <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-[150px]" />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-[184px]" />
        ))}
      </div>
    </div>
  );
}
