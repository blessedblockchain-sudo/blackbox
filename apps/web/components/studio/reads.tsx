"use client";
import clsx from "clsx";
import { disassemble } from "@blackbox/sdk/src/vm";
import { faultName, legPnl, type MarketView, type PositionView, type StrategyView } from "../../lib/chain";
import { formatInt, formatPercent, formatPrice, formatUsd, plainDecimal, plural, returnPct } from "../../lib/format";
import { Badge, Panel, PanelHeader, Skeleton, Stat } from "../ui";
import type { OwnerReads } from "./use-owner";

function ReadState({ reads, what }: { reads: OwnerReads; what: string }) {
  if (reads.status === "idle") return <p className="px-3 py-6 text-sm text-fg-dim">Pick an identity to read its {what}.</p>;
  if (reads.status === "unauthenticated") return <p className="px-3 py-6 text-sm text-fg-dim">Sign in to the TEE to read your {what}.</p>;
  if (reads.status === "loading")
    return (
      <div className="space-y-2 p-3" aria-busy="true">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  return null;
}

export function StrategyPanel({ reads }: { reads: OwnerReads }) {
  const s = reads.strategy;
  const lines = s ? disassemble(s.bytecode) : [];
  const pending = ReadState({ reads, what: "strategy" });
  return (
    <Panel>
      <PanelHeader title="Your strategy · authenticated read" meta={s ? `v${s.version}` : undefined} />
      {pending ?? (
        <>
          {reads.status === "error" ? (
            <p className="border-b border-edge px-3 py-2 text-xs text-loss" role="alert">
              Read failed: {reads.error}. Retrying.
            </p>
          ) : null}
          {s ? (
            <>
              <div className="grid grid-cols-2 gap-3 px-3 py-3 sm:grid-cols-4">
                <Stat label="Version">v{s.version}</Stat>
                <Stat label="Length">{formatInt(s.len)} B</Stat>
                <Stat label="Step limit">{formatInt(s.stepLimit)}</Stat>
                <Stat label="Updated tick">{s.updatedTick ? formatInt(s.updatedTick) : "--"}</Stat>
              </div>
              <div className="num truncate border-t border-edge px-3 py-1.5 text-[11px] text-fg-dim" title={reads.strategyHash}>
                sha256 {reads.strategyHash || "--"}
              </div>
              <pre className="num max-h-64 overflow-auto border-t border-edge bg-void px-3 py-2 text-xs leading-5 text-fg-muted" aria-label="Disassembly">
                {lines.length
                  ? lines.map((l) => (
                      <div key={l.offset}>
                        <span className="text-fg-faint">{String(l.offset).padStart(4, "0")}</span>
                        {"  "}
                        {l.text}
                      </div>
                    ))
                  : "empty strategy"}
              </pre>
            </>
          ) : reads.status === "ok" ? (
            <p className="px-3 py-6 text-sm text-fg-dim">No Strategy account visible for this identity in this round. It has not joined, or the account is not delegated yet.</p>
          ) : null}
        </>
      )}
    </Panel>
  );
}

export function PositionPanel({ reads, markets, names }: { reads: OwnerReads; markets: (MarketView | null)[]; names: string[] }) {
  const p = reads.position;
  const pending = ReadState({ reads, what: "position" });
  const upnl = p ? p.legs.reduce((a, l) => a + legPnl(l, markets[l.market]?.mark ?? NaN), 0) : 0;
  const equity = p ? p.margin + p.realizedPnl + upnl : NaN;
  const fault = p ? faultName(p.lastFault) : null;
  return (
    <Panel>
      <PanelHeader title="Your position · private" meta={p ? plural(p.tradeCount, "trade") : undefined} />
      {pending ??
        (p ? (
          <PositionBody p={p} equity={equity} upnl={upnl} fault={fault} markets={markets} names={names} />
        ) : reads.status === "ok" ? (
          <p className="px-3 py-6 text-sm text-fg-dim">No Position account visible for this identity in this round.</p>
        ) : reads.status === "error" ? (
          <p className="px-3 py-6 text-sm text-loss">Read failed: {reads.error}</p>
        ) : null)}
    </Panel>
  );
}

function PositionBody({ p, equity, upnl, fault, markets, names }: { p: PositionView; equity: number; upnl: number; fault: string | null; markets: (MarketView | null)[]; names: string[] }) {
  const ret = returnPct(equity, p.margin);
  return (
    <>
      <div className="grid grid-cols-2 gap-3 px-3 py-3 sm:grid-cols-4">
        <Stat label="Equity (est.)" hint={<span className={clsx(ret > 0 ? "text-gain" : ret < 0 ? "text-loss" : "")}>{formatPercent(ret, { signed: true })} on margin</span>}>
          {formatUsd(equity)}
        </Stat>
        <Stat label="Margin">{formatUsd(p.margin)}</Stat>
        <Stat label="Realized">
          <span className={clsx(p.realizedPnl > 0 ? "text-gain" : p.realizedPnl < 0 ? "text-loss" : "")}>{formatUsd(p.realizedPnl, { signed: true })}</span>
        </Stat>
        <Stat label="Unrealized">
          <span className={clsx(upnl > 0 ? "text-gain" : upnl < 0 ? "text-loss" : "")}>{formatUsd(upnl, { signed: true })}</span>
        </Stat>
      </div>
      <div className="overflow-x-auto border-t border-edge">
        <table className="w-full min-w-[480px] text-xs">
          <caption className="sr-only">Open legs</caption>
          <thead>
            <tr className="label-caps text-left">
              <th scope="col" className="px-3 py-1.5 font-normal">Market</th>
              <th scope="col" className="px-3 py-1.5 font-normal">Side</th>
              <th scope="col" className="px-3 py-1.5 text-right font-normal">Notional</th>
              <th scope="col" className="px-3 py-1.5 text-right font-normal">Entry</th>
              <th scope="col" className="px-3 py-1.5 text-right font-normal">Mark</th>
              <th scope="col" className="px-3 py-1.5 text-right font-normal">uPnL</th>
            </tr>
          </thead>
          <tbody className="num">
            {p.legs.length ? (
              p.legs.map((l) => {
                const mark = markets[l.market]?.mark ?? NaN;
                const pnl = legPnl(l, mark);
                return (
                  <tr key={l.market} className="border-t border-edge">
                    <td className="px-3 py-1.5 text-fg">{names[l.market] ?? `m${l.market}`}</td>
                    <td className={clsx("px-3 py-1.5", l.side > 0 ? "text-gain" : "text-loss")}>{l.side > 0 ? "LONG" : "SHORT"}</td>
                    <td className="px-3 py-1.5 text-right">{formatUsd(l.size)}</td>
                    <td className="px-3 py-1.5 text-right">{formatPrice(l.entry)}</td>
                    <td className="px-3 py-1.5 text-right text-fg-muted">{formatPrice(mark)}</td>
                    <td className={clsx("px-3 py-1.5 text-right", pnl > 0 ? "text-gain" : pnl < 0 ? "text-loss" : "")}>{formatUsd(pnl, { signed: true })}</td>
                  </tr>
                );
              })
            ) : (
              <tr className="border-t border-edge">
                <td colSpan={6} className="px-3 py-3 font-sans text-fg-dim">
                  Flat. No open legs.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-edge px-3 py-2 text-xs text-fg-dim">
        <span className="num">last run {formatInt(p.lastSteps)} steps</span>
        <span className="num">peak {formatUsd(p.peakEquity)}</span>
        {fault ? (
          <Badge tone="warn">
            last fault {fault} @ pc {p.lastFaultPc}
          </Badge>
        ) : (
          <span>no fault</span>
        )}
        {p.liquidated ? <Badge tone="loss">liquidated</Badge> : null}
        <span className="num ml-auto" title="Persistent memory slots mem[0..15], 6-dp fixed point">
          mem {p.mem.some((m) => m !== "0") ? p.mem.map((m, i) => (m !== "0" ? `[${i}]=${plainDecimal(Number(m) / 1e6, 6)}` : null)).filter(Boolean).join(" ") : "all zero"}
        </span>
      </div>
    </>
  );
}
