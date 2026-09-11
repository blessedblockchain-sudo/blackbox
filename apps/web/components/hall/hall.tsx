"use client";
import { useEffect, useState } from "react";
import clsx from "clsx";
import { MotionConfig, motion } from "framer-motion";
import type { HallResponse, HallRow } from "../../lib/api-types";
import { baseAddressExplorer } from "../../lib/explorer";
import { formatInt, formatUsd, shortAddr } from "../../lib/format";
import { Button, ExtLink, Panel, PanelHeader, Skeleton } from "../ui";

const REFRESH_MS = 15_000;

function eloDelta(elo: number): string {
  const d = elo - 1000;
  return d === 0 ? "±0" : `${d > 0 ? "+" : "-"}${formatInt(Math.abs(d))}`;
}

function Row({ r, i, data }: { r: HallRow; i: number; data: HallResponse }) {
  const podium = i < 3;
  return (
    <motion.tr
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, delay: Math.min(i, 15) * 0.03, ease: [0.25, 1, 0.5, 1] }}
      className="border-t border-edge transition-colors duration-150 hover:bg-surface-2/50"
    >
      <td className={clsx("num px-3 py-2", podium ? "text-fg" : "text-fg-dim")}>#{i + 1}</td>
      <td className="px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="truncate font-mono text-[13px] text-fg">{r.name ?? shortAddr(r.wallet)}</span>
          {r.bot ? <span className="label-caps !text-[10px]">bot</span> : null}
        </div>
        <div className="num text-[11px] text-fg-faint" title={r.wallet}>
          {r.name ? shortAddr(r.wallet) : "name not in the current round file"}
        </div>
      </td>
      <td className="px-3 py-2 text-right">
        <span className="num text-[15px] text-fg">{formatInt(r.elo)}</span>
        <span className={clsx("num ml-2 text-[11px]", r.elo > 1000 ? "text-gain" : r.elo < 1000 ? "text-loss" : "text-fg-dim")}>{eloDelta(r.elo)}</span>
      </td>
      <td className="num px-3 py-2 text-right text-fg-muted">{formatInt(r.rounds)}</td>
      <td className="num px-3 py-2 text-right text-fg-muted">{formatInt(r.wins)}</td>
      <td className="num px-3 py-2 text-right text-fg-muted">{formatInt(r.podiums)}</td>
      <td className={clsx("num px-3 py-2 text-right", r.totalPnl > 0 ? "text-gain" : r.totalPnl < 0 ? "text-loss" : "text-fg-muted")}>{formatUsd(r.totalPnl, { signed: true })}</td>
      <td className="num px-3 py-2 text-right text-fg-muted">{r.bestRank ? `#${r.bestRank}` : "--"}</td>
      <td className="px-3 py-2 text-right">
        <ExtLink href={baseAddressExplorer(r.hall, data.cluster, data.base)} className="num text-[11px] text-fg-dim">
          {shortAddr(r.hall)}
        </ExtLink>
      </td>
    </motion.tr>
  );
}

export function Hall() {
  const [data, setData] = useState<HallResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const res = await fetch("/api/hall", { cache: "no-store" });
        const body = (await res.json()) as HallResponse | { error: string };
        if (!res.ok || "error" in body) throw new Error("error" in body ? body.error : `HTTP ${res.status}`);
        if (!stop) {
          setData(body);
          setError(null);
        }
      } catch (e) {
        if (!stop) setError(e instanceof Error ? e.message : String(e));
      }
      if (!stop) {
        setLoading(false);
        timer = setTimeout(load, REFRESH_MS);
      }
    };
    load();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [nonce]);

  return (
    <MotionConfig reducedMotion="user">
      <div className="flex flex-col gap-3">
        <header className="border border-edge bg-surface px-4 py-3">
          <h1 className="font-mono text-lg font-medium tracking-tight">Hall of Fame</h1>
          <p className="mt-2 max-w-[92ch] text-sm leading-6 text-fg-muted">
            After every settled round, record_hall folds each entrant&apos;s rank and PnL into a permanent Hall account on Solana L1, one per wallet. ELO starts at 1,000 and moves by up to 16 a round
            (K = 32 against a mid-table finish); strategies stay sealed, only results are kept.
          </p>
        </header>
        <Panel aria-label="Hall of Fame">
          <PanelHeader
            title={data ? `Wallets · ${formatInt(data.rows.length)}` : "Wallets"}
            meta={data ? `L1 Hall accounts · ${data.cluster} · refreshed every ${REFRESH_MS / 1000} s` : undefined}
          />
          {loading && !data ? (
            <div className="space-y-2 p-3" aria-busy="true" aria-label="Loading Hall accounts">
              {Array.from({ length: 5 }, (_, i) => (
                <Skeleton key={i} className="h-9 w-full" />
              ))}
            </div>
          ) : error && !data ? (
            <div className="px-3 py-8">
              <p role="alert" className="text-sm text-loss">
                Could not read the Hall of Fame: {error}
              </p>
              <Button className="mt-3" onClick={() => setNonce((n) => n + 1)}>
                Try again
              </Button>
            </div>
          ) : data && !data.rows.length ? (
            <div className="px-3 py-10 text-center">
              <p className="text-sm text-fg-muted">No Hall of Fame records yet.</p>
              <p className="mt-1 text-xs text-fg-dim">record_hall writes one per entrant once a round settles and returns to L1. Run a round to the end and this table fills in.</p>
            </div>
          ) : data ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-xs">
                <caption className="sr-only">Hall of Fame, sorted by ELO</caption>
                <thead>
                  <tr className="label-caps text-left">
                    <th scope="col" className="w-12 px-3 py-2 font-normal">
                      #
                    </th>
                    <th scope="col" className="px-3 py-2 font-normal">
                      Wallet
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-normal">
                      ELO
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-normal">
                      Rounds
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-normal">
                      Wins
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-normal">
                      Podiums
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-normal">
                      Total PnL
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-normal">
                      Best rank
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-normal">
                      Hall account
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r, i) => (
                    <Row key={r.hall} r={r} i={i} data={data} />
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {data ? (
            <footer className="num flex flex-wrap gap-x-4 gap-y-1 border-t border-edge px-3 py-2 text-[11px] text-fg-dim">
              <span>program.account.hall.all() on {data.base}</span>
              {error ? <span className="text-warn">last refresh failed: {error}</span> : null}
            </footer>
          ) : null}
        </Panel>
      </div>
    </MotionConfig>
  );
}
