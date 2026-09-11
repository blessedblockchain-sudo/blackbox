"use client";
import { useState } from "react";
import clsx from "clsx";
import { Play } from "lucide-react";
import type { SimOptions, SimResult, SimTick } from "@blackbox/compiler";
import { formatInt, formatPercent, formatRatio, formatUsd, plural } from "../../lib/format";
import { LineChart } from "../charts";
import { Badge, Button, Panel, PanelHeader, Stat } from "../ui";

export type Simulate = (bytecode: Uint8Array, series: SimTick[], opts: SimOptions) => SimResult;

interface Run {
  draft: SimResult;
  deployed: SimResult | null;
  ticks: number;
  source: string;
  sourceHash: string;
}

export function SimPanel({
  simulate,
  bytecode,
  deployed,
  series,
  seriesSource,
  opts,
  sourceHash,
}: {
  simulate: Simulate | null;
  bytecode: Uint8Array | null;
  deployed: Uint8Array | null;
  series: SimTick[];
  seriesSource: string;
  opts: SimOptions;
  sourceHash: string;
}) {
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState<string | null>(null);
  const margin = opts.margin ?? 100;
  const canRun = !!simulate && !!bytecode && series.length > 1;

  const go = () => {
    if (!simulate || !bytecode) return;
    setError(null);
    try {
      const draft = simulate(bytecode, series, opts);
      const dep = deployed && deployed.length > 1 ? simulate(deployed, series, opts) : null;
      setRun({ draft, deployed: dep, ticks: series.length, source: seriesSource, sourceHash });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const r = run?.draft;
  const ret = r ? ((r.finalEquity - margin) / margin) * 100 : NaN;
  return (
    <Panel>
      <PanelHeader title="Backtest" meta={series.length > 1 ? `${formatInt(series.length)} ticks · ${seriesSource}` : "waiting for price history"} />
      <div className="flex flex-wrap items-center gap-3 px-3 py-2.5">
        <Button onClick={go} disabled={!canRun}>
          <Play aria-hidden className="size-3.5" /> Simulate
        </Button>
        <p className="text-xs text-fg-dim">
          Replays the draft through a TypeScript port of the on-chain VM and perps engine on this round&apos;s recorded marks, from {formatUsd(margin)} margin.
        </p>
        {run && run.sourceHash !== sourceHash ? <Badge tone="warn">source changed since this run</Badge> : null}
      </div>
      {error ? (
        <p className="border-t border-edge px-3 py-2 text-xs text-loss" role="alert">
          Simulation failed: {error}
        </p>
      ) : null}
      {r ? (
        <div className="border-t border-edge">
          <div className="grid grid-cols-2 gap-3 px-3 py-3 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Final equity">{formatUsd(r.finalEquity)}</Stat>
            <Stat label="Return">
              <span className={clsx(ret > 0 ? "text-gain" : ret < 0 ? "text-loss" : "")}>{formatPercent(ret, { signed: true })}</span>
            </Stat>
            <Stat label="Trades">{formatInt(r.trades)}</Stat>
            <Stat label="Max drawdown">{formatPercent(r.maxDrawdown * 100)}</Stat>
            <Stat label="Sharpe">{Number.isFinite(r.sharpe) ? formatRatio(r.sharpe).replace(/x$/, "") : "--"}</Stat>
            <Stat label="Outcome">{r.liquidated ? <span className="text-loss">Liquidated</span> : r.faults.length ? <span className="text-warn">{plural(r.faults.length, "fault")}</span> : "Clean"}</Stat>
          </div>
          <div className="px-3 pb-3">
            <LineChart
              label="Simulated equity curve"
              height={170}
              baseline={margin}
              format={(v) => formatUsd(v)}
              series={[
                ...(run.deployed ? [{ name: "deployed", values: run.deployed.equity, color: "var(--color-fg-dim)" }] : []),
                { name: "draft", values: r.equity, color: "var(--color-gain)" },
              ]}
            />
            <div className="mt-2 flex flex-wrap gap-4 text-xs text-fg-dim">
              <span className="flex items-center gap-1.5">
                <span aria-hidden className="h-px w-4 bg-gain" /> draft
              </span>
              {run.deployed ? (
                <span className="flex items-center gap-1.5">
                  <span aria-hidden className="h-px w-4 bg-fg-dim" /> deployed v-current ({formatUsd(run.deployed.finalEquity)})
                </span>
              ) : null}
              <span className="flex items-center gap-1.5">
                <span aria-hidden className="h-px w-4 border-t border-dashed border-fg-faint" /> starting margin
              </span>
              {r.faults.length ? <span className="text-warn">first fault: {r.faults[0].fault} at tick {r.faults[0].tick}, pc {r.faults[0].pc}</span> : null}
            </div>
          </div>
        </div>
      ) : null}
    </Panel>
  );
}
