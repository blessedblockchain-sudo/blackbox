"use client";
import clsx from "clsx";
import { motion } from "framer-motion";
import { Lock } from "lucide-react";
import { MAX_LICENSES_PER_AUTHOR, type RoundView } from "../../lib/chain";
import { formatBps, formatInt, formatPercent, formatUsd, shortAddr } from "../../lib/format";
import { Badge, Button } from "../ui";

export interface AuthorRow {
  owner: string;
  name: string;
  bot: boolean;
  external: boolean;
  index: number;
  /** Public Entrant fields; null until the Entrant account has been read. */
  feePriceBps: number | null;
  licenseCount: number | null;
  strategyVersion: number | null;
  settled: boolean;
  /** Lit scoreboard; null when sealed or not yet read. */
  equity: number | null;
  returnPct: number | null;
  alive: boolean | null;
  /** Names of wallets that license this strategy (from the round file). */
  backers: string[];
  /** The local web backer already holds an active license on it. */
  youBack: boolean;
}

/** Why this strategy cannot be backed right now (null when it can). */
export function rowBlock(row: AuthorRow, gate: string | null): string | null {
  if (gate) return gate;
  if (row.feePriceBps === null) return "Reading the author's public Entrant account.";
  // settle_entrant clears `alive` for everyone, so "not alive" only means
  // liquidated while the entrant is still unsettled.
  if (row.settled) return "This entrant is settled: its book is closed and its strategy hash is published.";
  if (row.alive === false) return "Liquidated: there is nothing left to run.";
  if ((row.licenseCount ?? 0) >= MAX_LICENSES_PER_AUTHOR) return `All ${MAX_LICENSES_PER_AUTHOR} licenses on this strategy are taken.`;
  if (row.youBack) return "The web backer already backs this strategy in this round.";
  return null;
}

const FEE_HINT = "Set inside the TEE from the author's private Sharpe ratio: 0 or less maps to the round minimum, 3 or more to the maximum. Nothing else about the strategy is published.";

function FeeCell({ fee, min, max }: { fee: number | null; min: number; max: number }) {
  const pct = fee === null || max <= min ? 0 : Math.max(0, Math.min(1, (fee - min) / (max - min)));
  return (
    <div className="flex items-center gap-2" title={FEE_HINT}>
      <span className="num w-16 text-[13px] text-fg">{formatBps(fee, { decimals: 0 })}</span>
      <span aria-hidden className="relative hidden h-1 w-14 shrink-0 bg-edge sm:block">
        <span className="absolute inset-y-0 left-0 bg-gain/70 transition-[width] duration-500 ease-out" style={{ width: `${pct * 100}%` }} />
      </span>
    </div>
  );
}

export function AuthorTable({
  rows,
  round,
  sealed,
  selected,
  onSelect,
  gate,
}: {
  rows: AuthorRow[];
  round: RoundView | null;
  sealed: boolean;
  selected: string | null;
  onSelect: (owner: string) => void;
  gate: string | null;
}) {
  const min = round?.licenseFeeMinBps ?? 0;
  const max = round?.licenseFeeMaxBps ?? 0;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs sm:min-w-[660px]">
        <caption className="sr-only">Sealed strategies in this round, sorted by blind license price</caption>
        <thead>
          <tr className="label-caps text-left">
            <th scope="col" className="hidden w-10 px-3 py-2 font-normal sm:table-cell">#</th>
            <th scope="col" className="px-2 py-2 font-normal sm:px-3">Author</th>
            <th scope="col" className="px-2 py-2 font-normal sm:px-3" title={FEE_HINT}>
              Blind price
            </th>
            <th scope="col" className="hidden px-3 py-2 text-right font-normal sm:table-cell">Licenses</th>
            <th scope="col" className="px-2 py-2 text-right font-normal sm:px-3">Equity</th>
            <th scope="col" className="hidden px-3 py-2 text-right font-normal sm:table-cell">Return</th>
            <th scope="col" className="px-3 py-2 font-normal">
              <span className="sr-only">Action</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const block = rowBlock(r, gate);
            const active = selected === r.owner;
            const ret = r.returnPct;
            const retTone = sealed || ret === null || !Number.isFinite(ret) || ret === 0 ? "text-fg-dim" : ret > 0 ? "text-gain" : "text-loss";
            return (
              <motion.tr
                key={r.owner}
                layout="position"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ layout: { type: "spring", stiffness: 420, damping: 42 }, opacity: { duration: 0.25, delay: Math.min(i, 12) * 0.03 }, y: { duration: 0.25, delay: Math.min(i, 12) * 0.03 } }}
                className={clsx("border-t border-edge transition-colors duration-150", active ? "bg-surface-2" : "hover:bg-surface-2/50", (r.settled || r.alive === false) && "opacity-60")}
              >
                <td className="num hidden px-3 py-2 text-fg-dim sm:table-cell">{i + 1}</td>
                <td className="px-2 py-2 sm:px-3">
                  <div className="flex items-center gap-2">
                    <Lock aria-hidden className="size-3 shrink-0 text-fg-dim" strokeWidth={1.75} />
                    <span className="truncate font-mono text-[13px] text-fg">{r.name}</span>
                    {r.bot ? <span className="label-caps !text-[10px]">bot</span> : null}
                    {r.external ? <Badge tone="dim">agent</Badge> : null}
                    {r.settled ? (
                      <span className="font-mono text-[10px] tracking-[0.08em] text-fg-dim uppercase">settled</span>
                    ) : r.alive === false ? (
                      <span className="font-mono text-[10px] tracking-[0.08em] text-loss uppercase">liquidated</span>
                    ) : null}
                  </div>
                  <div className="num mt-0.5 text-[11px] text-fg-faint">
                    {shortAddr(r.owner)}
                    {r.strategyVersion ? ` · strategy v${r.strategyVersion}` : ""}
                  </div>
                </td>
                <td className="px-2 py-2 sm:px-3">
                  <FeeCell fee={r.feePriceBps} min={min} max={max} />
                </td>
                <td className="hidden px-3 py-2 text-right sm:table-cell">
                  <span className="num text-fg-muted">{r.licenseCount === null ? "--" : `${formatInt(r.licenseCount)}/${MAX_LICENSES_PER_AUTHOR}`}</span>
                  {r.backers.length ? (
                    <div className="ml-auto max-w-[9rem] truncate text-[11px] text-fg-dim" title={`Backed by ${r.backers.join(", ")}`}>
                      {r.backers.join(", ")}
                    </div>
                  ) : null}
                </td>
                <td className="num px-2 py-2 text-right text-fg sm:px-3">{sealed ? <span className="label-caps">sealed</span> : formatUsd(r.equity)}</td>
                <td className={clsx("num hidden px-3 py-2 text-right sm:table-cell", retTone)}>{sealed ? "--" : formatPercent(ret, { signed: true })}</td>
                <td className="py-1.5 pr-2 pl-1 text-right sm:px-3">
                  <Button
                    variant={active ? "primary" : block ? "ghost" : "secondary"}
                    onClick={() => onSelect(r.owner)}
                    aria-pressed={active}
                    aria-label={`${block ? "Details for" : "Back"} ${r.name}`}
                    className="px-2 sm:min-w-[4.5rem] sm:px-3"
                  >
                    {block ? "Details" : "Back"}
                  </Button>
                </td>
              </motion.tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
