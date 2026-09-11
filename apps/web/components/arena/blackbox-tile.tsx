"use client";
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { Lock } from "lucide-react";
import { formatBps, formatInt, formatPercent, formatUsd, plural, shortAddr } from "../../lib/format";
import { Sparkline } from "../charts";
import { Odometer } from "../num";

export interface TileData {
  owner: string;
  name: string;
  index: number;
  rank: number | null;
  /** null when the scoreboard is sealed (dark round). */
  equity: number | null;
  deposited: number | null;
  returnPct: number | null;
  trades: number | null;
  alive: boolean | null;
  strategyVersion: number | null;
  strategyHash: string;
  /** Public Entrant fields: blind license price (bps) and active license count. */
  feePriceBps: number | null;
  licenseCount: number | null;
  bot: boolean;
  history: number[];
}

/** Byte size of the Strategy code region (bytecode[4096]); the live length is private. */
const CODE_REGION = 4096;

export function BlackboxTile({ t, sealed }: { t: TileData; sealed: boolean }) {
  const prev = useRef<number | null>(t.equity);
  const [flash, setFlash] = useState<{ n: number; dir: "gain" | "loss" } | null>(null);
  useEffect(() => {
    if (t.equity !== null && prev.current !== null && t.equity !== prev.current) {
      const dir = t.equity > prev.current ? "gain" : "loss";
      setFlash((f) => ({ n: (f?.n ?? 0) + 1, dir }));
    }
    prev.current = t.equity;
  }, [t.equity]);

  const liquidated = t.alive === false;
  const ret = t.returnPct;
  const retTone = ret === null || !Number.isFinite(ret) || ret === 0 ? "text-fg-dim" : ret > 0 ? "text-gain" : "text-loss";
  const sealedFacts = [
    t.strategyVersion ? `strategy v${t.strategyVersion}` : "strategy",
    "sealed in TEE",
    t.strategyHash ? `sha256 ${t.strategyHash.slice(0, 8)}… published` : `${formatInt(CODE_REGION)}-byte code region hidden`,
  ];
  const blind = t.feePriceBps === null ? null : `blind price ${formatBps(t.feePriceBps, { decimals: 0 })}, ${plural(t.licenseCount, "license")}`;
  const label = `${t.name}, ${sealed ? "equity sealed" : `equity ${formatUsd(t.equity)}, return ${formatPercent(ret, { signed: true })}, ${plural(t.trades, "trade")}`}${liquidated ? ", liquidated" : ""}${blind ? `, ${blind}` : ""}. ${sealedFacts.join(", ")}.`;

  return (
    <article
      tabIndex={0}
      aria-label={label}
      className={clsx(
        "group bx-texture relative isolate flex min-h-[184px] flex-col overflow-hidden border border-edge outline-none transition-colors duration-200",
        "hover:border-edge-strong focus-visible:border-gain/60",
        liquidated && "opacity-60",
      )}
    >
      {flash ? <span key={flash.n} aria-hidden className={clsx("pointer-events-none absolute inset-0 z-10 border border-transparent", flash.dir === "gain" ? "flash-gain" : "flash-loss")} /> : null}

      <header className="flex items-center gap-2 px-3 pt-2.5">
        <span className={clsx("num w-7 text-xs", t.rank !== null && t.rank <= 3 ? "text-fg" : "text-fg-dim")}>{t.rank !== null ? `#${t.rank}` : "--"}</span>
        <h3 className="min-w-0 flex-1 truncate font-mono text-[13px] font-medium text-fg">{t.name}</h3>
        {t.bot ? <span className="label-caps !text-[10px]">bot</span> : null}
        <Lock aria-hidden className="size-3.5 text-fg-dim transition-colors duration-200 group-hover:text-fg-muted" strokeWidth={1.75} />
      </header>
      <div className="num px-3 text-[11px] text-fg-faint">{shortAddr(t.owner, 4, 4)}</div>

      <div className="mt-3 flex items-baseline justify-between gap-2 px-3">
        {sealed ? (
          <span className="flex items-center gap-2" aria-hidden>
            <span className="h-4 w-24 bg-edge-strong" />
            <span className="label-caps">sealed</span>
          </span>
        ) : (
          <>
            <Odometer value={formatUsd(t.equity)} className={clsx("text-[20px] leading-6 font-medium", liquidated && "line-through decoration-loss/70")} label={`equity ${formatUsd(t.equity)}`} />
            <span className={clsx("num text-xs", retTone)}>{formatPercent(ret, { signed: true })}</span>
          </>
        )}
      </div>

      <div className="mt-2 px-3">
        {sealed ? (
          <div className="h-9 border-y border-dashed border-edge" aria-hidden />
        ) : (
          <Sparkline values={t.history} baseline={t.deposited ?? undefined} width={260} height={36} className="h-9" label={`${t.name} equity history`} />
        )}
      </div>

      <div
        className="mt-2 flex items-center gap-2 px-3 text-[11px]"
        title="Blind license price: set inside the TEE from the author's private Sharpe ratio. Backers pay it on every trade their book makes."
      >
        <span className="label-caps !text-[10px]">blind price</span>
        <span className="num text-fg-muted">{formatBps(t.feePriceBps, { decimals: 0 })}</span>
        <span aria-hidden className="text-fg-faint">
          ·
        </span>
        <span className="num text-fg-muted">{t.licenseCount === null ? "-- licenses" : plural(t.licenseCount, "license")}</span>
      </div>

      <footer className="mt-auto flex items-center gap-3 px-3 pt-2 pb-2.5 text-xs">
        <span className="num text-fg-muted">{sealed ? "-- trades" : plural(t.trades, "trade")}</span>
        {t.alive === null ? null : liquidated ? (
          <span className="font-mono text-[11px] tracking-[0.08em] text-loss uppercase">Liquidated</span>
        ) : (
          <span className="flex items-center gap-1.5 font-mono text-[11px] tracking-[0.08em] text-fg-dim uppercase">
            <span aria-hidden className="size-1.5 rounded-full bg-gain" />
            alive
          </span>
        )}
        <span className="num ml-auto text-fg-dim">{t.strategyVersion ? `v${t.strategyVersion}` : ""}</span>
      </footer>

      {/* Sealed facts: what is known about the box without opening it. */}
      <div
        aria-hidden
        className="absolute inset-x-0 bottom-0 z-20 translate-y-full border-t border-edge-strong bg-void/95 px-3 py-2 font-mono text-[11px] leading-4 text-fg-muted transition-transform duration-200 ease-[var(--ease-out-quart)] group-hover:translate-y-0 group-focus-visible:translate-y-0 motion-reduce:transition-none"
      >
        {sealedFacts.join(" · ")}
      </div>
    </article>
  );
}
