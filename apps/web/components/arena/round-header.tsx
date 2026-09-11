"use client";
import clsx from "clsx";
import type { PublicRoundInfo } from "../../lib/api-types";
import type { RoundView } from "../../lib/chain";
import { formatDuration, formatInt, formatPercent, formatUsd } from "../../lib/format";
import type { Solvency } from "../../lib/solvency";
import { Badge, Dot, Panel } from "../ui";
import { Odometer } from "../num";

const PHASE_LABEL: Record<string, string> = {
  created: "Created",
  open: "Registration",
  live: "Live",
  settling: "Settling",
  settled: "Settled",
};

export function phaseLabel(round: RoundView | null, info: PublicRoundInfo | null): string {
  if (round?.status === "open" && info?.phase === "delegating") return "Delegating";
  if (round) return PHASE_LABEL[round.status] ?? round.status;
  return info?.phase ? info.phase[0].toUpperCase() + info.phase.slice(1) : "Unknown";
}

export function RoundHeader({ info, round, solvency, latencyMs, status }: { info: PublicRoundInfo; round: RoundView; solvency: Solvency; latencyMs: number | null; status: string }) {
  const progress = round.durationTicks > 0 ? Math.min(1, round.tick / round.durationTicks) : 0;
  const ticksLeft = Math.max(0, round.durationTicks - round.tick);
  const live = round.status === "live";
  const phase = phaseLabel(round, info);
  const mystery = round.vrfReady && round.mysteryMarket !== null ? info.markets[round.mysteryMarket] ?? `market ${round.mysteryMarket}` : null;
  const solvencyTone = solvency.state === "covered" ? "gain" : solvency.state === "thin" ? "warn" : solvency.state === "short" ? "loss" : "dim";

  return (
    <Panel aria-label="Round status">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-edge px-3 py-2.5">
        <h1 className="num text-xl leading-7 font-medium tracking-tight">
          Round <span className="text-fg">{String(round.id).padStart(2, "0")}</span>
        </h1>
        <Badge tone={live ? "gain" : round.status === "settling" ? "warn" : "dim"}>
          <Dot tone={live ? "gain" : round.status === "settling" ? "warn" : "dim"} pulse={live} />
          {phase}
        </Badge>
        <Badge tone={round.mode === "dark" ? "neutral" : "dim"} title={round.mode === "dark" ? "Scoreboard is program-only: equities are sealed until settlement" : "Scoreboard is public: equity, trades and liveness are visible"}>
          {round.mode === "dark" ? "Dark round" : "Lit round"}
        </Badge>
        <Badge tone="dim">{info.cluster}</Badge>
        <div className="ml-auto flex items-center gap-2 text-xs text-fg-dim" aria-live="polite">
          <Dot tone={status === "live" ? "gain" : status === "stale" ? "warn" : "loss"} />
          <span className="num">
            TEE {status === "live" ? "synced" : status}
            {latencyMs !== null ? ` · ${latencyMs} ms` : ""}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-6 gap-y-4 px-3 py-3 md:grid-cols-3 xl:grid-cols-[minmax(0,2.2fr)_repeat(4,minmax(0,1fr))]">
        <div className="col-span-2 md:col-span-3 xl:col-span-1">
          <div className="flex items-baseline justify-between gap-3">
            <span className="label-caps">Tick</span>
            <span className="num text-xs text-fg-dim">{formatPercent(progress * 100)} elapsed</span>
          </div>
          <div className="mt-1 flex items-baseline gap-1.5">
            <span key={round.tick} className="pulse-once text-[22px] leading-7 font-medium">
              <Odometer value={formatInt(round.tick)} label={`tick ${round.tick}`} />
            </span>
            <span className="num text-[15px] text-fg-dim">/ {formatInt(round.durationTicks)}</span>
          </div>
          <div className="mt-2 h-1 w-full bg-edge" role="progressbar" aria-label="Round progress" aria-valuemin={0} aria-valuemax={round.durationTicks} aria-valuenow={round.tick}>
            <div className="h-full bg-gain transition-[width] duration-500 ease-out" style={{ width: `${progress * 100}%` }} />
          </div>
        </div>

        <HeaderStat label="Time left" hint={`${formatInt(ticksLeft)} ticks × ${formatInt(round.tickIntervalMs)} ms`}>
          {live || round.status === "open" ? formatDuration(ticksLeft * round.tickIntervalMs) : round.status === "settled" ? "Ended" : "--"}
        </HeaderStat>
        <HeaderStat label="Prize pot" hint={`${formatInt(round.entrantCount)} entrants × ${formatUsd(round.entryFee)}`}>
          <Odometer value={formatUsd(round.pot)} />
        </HeaderStat>
        <HeaderStat label="Mystery market" hint={round.vrfReady ? "drawn by VRF in the rollup" : "awaiting VRF"}>
          {mystery ?? <span className="text-fg-dim">Sealed</span>}
        </HeaderStat>
        <div className="min-w-0">
          <div className="label-caps">Solvency</div>
          <div className="mt-1 flex items-center gap-2 text-[15px] leading-5">
            <Dot tone={solvencyTone} pulse={solvency.state === "short"} className="size-2" />
            <span className={clsx("num", { gain: "text-fg", warn: "text-warn", loss: "text-loss", dim: "text-fg-dim" }[solvencyTone])}>
              {solvency.state === "unknown" ? "--" : `${formatPercent(solvency.coverage)} covered`}
            </span>
          </div>
          <div className="num mt-0.5 truncate text-xs text-fg-dim" title={`Held: custody ${formatUsd(solvency.custody)} + vault ${formatUsd(solvency.vault)}. Owed: equity ${formatUsd(solvency.equity)} + pot ${formatUsd(solvency.pot)}.`}>
            held {formatUsd(solvency.held, { compact: true })} / owed {formatUsd(solvency.owed, { compact: true })}
          </div>
        </div>
      </div>
    </Panel>
  );
}

function HeaderStat({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="label-caps">{label}</div>
      <div className="num mt-1 text-[15px] leading-5">{children}</div>
      {hint ? <div className="num mt-0.5 truncate text-xs text-fg-dim">{hint}</div> : null}
    </div>
  );
}
