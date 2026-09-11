"use client";
import clsx from "clsx";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import type { MarketView } from "../../lib/chain";
import { formatBps, formatPercent, formatPrice, formatRatio, formatUsd } from "../../lib/format";
import { Sparkline } from "../charts";
import { Odometer } from "../num";
import { Badge, Skeleton } from "../ui";

export function MarketStrip({ names, markets, mystery }: { names: string[]; markets: (MarketView | null)[]; mystery: number | null }) {
  return (
    <div className="grid grid-cols-1 gap-px border border-edge bg-edge md:grid-cols-3" aria-label="Markets">
      {names.map((name, i) => (
        <MarketCard key={name} name={name} market={markets[i] ?? null} mystery={mystery === i} />
      ))}
    </div>
  );
}

function MarketCard({ name, market, mystery }: { name: string; market: MarketView | null; mystery: boolean }) {
  if (!market) {
    return (
      <div className="bg-surface px-3 py-3">
        <div className="label-caps">{name}</div>
        <Skeleton className="mt-2 h-7 w-32" />
        <Skeleton className="mt-3 h-10 w-full" />
      </div>
    );
  }
  const ring = market.ring;
  const first = ring[0];
  const change = ring.length > 1 && first > 0 ? ((market.mark - first) / first) * 100 : NaN;
  const up = market.ema8 >= market.ema21;
  const TrendIcon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <article className="min-w-0 bg-surface px-3 py-3" aria-label={`${name} market`}>
      <div className="flex items-center gap-2">
        <h3 className="font-mono text-xs font-medium tracking-[0.08em] text-fg">{name}</h3>
        <span className="num text-xs text-fg-dim">{formatRatio(market.maxLeverage)}</span>
        {mystery ? <Badge tone="warn" title="Drawn by VRF at round start">Mystery</Badge> : null}
        <span className={clsx("num ml-auto text-xs", Number.isFinite(change) ? (change > 0 ? "text-gain" : change < 0 ? "text-loss" : "text-fg-dim") : "text-fg-dim")} title={`Change over the last ${ring.length} ticks`}>
          {formatPercent(change, { signed: true })}
        </span>
      </div>
      <div className="mt-1.5 flex items-end justify-between gap-3">
        <Odometer value={formatPrice(market.mark, "detailed")} className="text-[22px] leading-7 font-medium" label={`${name} mark ${formatPrice(market.mark, "detailed")}`} />
        <div className={clsx("flex items-center gap-1 pb-0.5 font-mono text-xs", up ? "text-gain" : "text-loss")} title={`EMA(8) ${formatPrice(market.ema8)} vs EMA(21) ${formatPrice(market.ema21)}`}>
          <TrendIcon aria-hidden className="size-3.5" />
          <span>EMA8 {up ? ">" : "<"} EMA21</span>
        </div>
      </div>
      <Sparkline values={ring} width={320} height={44} className="mt-2 h-11" label={`${name} last ${ring.length} marks`} />
      <dl className="mt-2 grid grid-cols-3 gap-2 text-xs">
        <div>
          <dt className="label-caps">Vol/tick</dt>
          <dd className="num mt-0.5 text-fg-muted">{formatBps(market.vol * 1e4)}</dd>
        </div>
        <div>
          <dt className="label-caps">Funding</dt>
          <dd className="num mt-0.5 text-fg-muted">{formatBps(market.fundingRateBps, { signed: true })}</dd>
        </div>
        <div>
          <dt className="label-caps">OI L/S</dt>
          <dd className="num mt-0.5 truncate text-fg-muted" title={`long ${formatUsd(market.oiLong)} / short ${formatUsd(market.oiShort)}`}>
            {formatUsd(market.oiLong, { compact: true })}/{formatUsd(market.oiShort, { compact: true })}
          </dd>
        </div>
      </dl>
    </article>
  );
}
