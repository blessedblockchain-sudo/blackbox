"use client";
import clsx from "clsx";
import { Lock } from "lucide-react";
import type { BackerLicense, PublicRoundInfo, ReadRequest } from "../../lib/api-types";
import { faultName, legPnl, type LegView, type MarketView } from "../../lib/chain";
import { erAddressExplorer } from "../../lib/explorer";
import { formatSol } from "../../lib/amount";
import { formatBps, formatInt, formatPercent, formatPrice, formatUsd, shortAddr } from "../../lib/format";
import { Odometer } from "../num";
import { Badge, ExtLink, Panel, PanelHeader, Skeleton, Stat } from "../ui";
import type { BackStateHandle } from "./use-back-state";

type Tone = "gain" | "loss" | "warn" | "dim";

function statusOf(l: BackerLicense): { tone: Tone; text: string } {
  const v = l.view;
  if (!v) return { tone: "dim", text: l.error ? "unreadable" : "not on the rollup yet" };
  if (v.scrubbed) return { tone: "dim", text: "settled · scrubbed" };
  if (v.liquidated) return { tone: "loss", text: "liquidated" };
  if (v.active) return { tone: "gain", text: "active" };
  return { tone: "warn", text: "not activated" };
}

function LegsTable({ legs, markets, names }: { legs: LegView[]; markets: (MarketView | null)[]; names: string[] }) {
  return (
    <div className="overflow-x-auto border-t border-edge">
      <table className="w-full min-w-[480px] text-xs">
        <caption className="sr-only">Open legs of this license book</caption>
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
          {legs.length ? (
            legs.map((l) => {
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
              <td colSpan={6} className="px-3 py-2.5 font-sans text-fg-dim">
                Flat. The strategy has no open legs on your book right now.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export function LicenseCard({ l, markets, names, info }: { l: BackerLicense; markets: (MarketView | null)[]; names: string[]; info: PublicRoundInfo }) {
  const v = l.view;
  const st = statusOf(l);
  const live = !!v && v.active && !v.scrubbed;
  const pnl = live ? v.lastEquity - v.margin : NaN;
  const ret = live && v.margin > 0 ? (pnl / v.margin) * 100 : NaN;
  const fault = v ? faultName(v.lastFault) : null;
  return (
    <article className="border-t border-edge first:border-t-0" aria-label={`License on ${l.authorName}`}>
      <header className="flex flex-wrap items-center gap-2 px-3 pt-2.5 pb-2">
        <Lock aria-hidden className="size-3.5 text-fg-dim" strokeWidth={1.75} />
        <h3 className="font-mono text-[13px] font-medium text-fg">{l.authorName}</h3>
        <Badge tone={st.tone}>{st.text}</Badge>
        {l.scheduled === false ? <Badge tone="warn">the runner schedules its crank</Badge> : null}
        <span className="num ml-auto text-[11px] text-fg-dim">
          License{" "}
          <ExtLink href={erAddressExplorer(l.license, info.cluster, info.endpoints.tee)} className="text-fg-muted">
            {shortAddr(l.license)}
          </ExtLink>
        </span>
      </header>
      {v && !v.scrubbed ? (
        <>
          <div className="grid grid-cols-2 gap-x-4 gap-y-3 px-3 pb-3 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Equity" hint="as of the last tick it ran">
              {live ? <Odometer value={formatUsd(v.lastEquity)} label={`equity ${formatUsd(v.lastEquity)}`} /> : "--"}
            </Stat>
            <Stat label="PnL" hint={live ? `${formatPercent(ret, { signed: true })} on margin` : undefined}>
              <span className={clsx(pnl > 0 ? "text-gain" : pnl < 0 ? "text-loss" : "")}>{formatUsd(pnl, { signed: true })}</span>
            </Stat>
            <Stat label="Fees accrued" hint={`to ${l.authorName} at settlement`}>
              {formatUsd(v.accruedFees)}
            </Stat>
            <Stat label="Trades">{formatInt(v.tradeCount)}</Stat>
            <Stat label="Fee locked" hint="of each trade's notional">
              {formatBps(v.feeBps, { decimals: 0 })}
            </Stat>
            <Stat label="Last tick" hint={v.openedTick ? `opened at tick ${formatInt(v.openedTick)}` : undefined}>
              {v.lastTick === null ? "--" : formatInt(v.lastTick)}
            </Stat>
          </div>
          <LegsTable legs={v.legs} markets={markets} names={names} />
          <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-edge px-3 py-2 text-[11px] text-fg-dim">
            <span className="num">margin {formatUsd(v.margin)}</span>
            <span className="num">realized {formatUsd(v.realizedPnl, { signed: true })} net of fees</span>
            <span className="num">peak {formatUsd(v.peakEquity)}</span>
            {fault ? <Badge tone="warn">last tick faulted: {fault}</Badge> : null}
            <span className="sm:ml-auto">Readable by you and {l.authorName}. The strategy&apos;s code is not in it.</span>
          </footer>
        </>
      ) : v?.scrubbed ? (
        <p className="px-3 pb-3 text-xs text-fg-dim">Settled: accrued fees went to {l.authorName}, the rest to your rollup balance, and the License body was zeroed before it goes back to L1.</p>
      ) : (
        <p className="px-3 pb-3 text-xs break-words text-fg-dim">
          {l.error ?? "The TEE has not returned this License to your token yet. It appears once delegate_license reaches the rollup."}
        </p>
      )}
    </article>
  );
}

function ReadLine({ read }: { read: ReadRequest }) {
  return (
    <div className="num flex flex-wrap gap-x-3 gap-y-0.5 border-t border-edge px-3 py-1.5 text-[11px] text-fg-dim" title="The authenticated read behind this panel. The token stays on the local server.">
      <span>
        {read.method} · {read.account}
      </span>
      <span className="truncate">{read.endpoint}</span>
      <span>
        {formatInt(read.ms)} ms · {read.found ? `${formatInt(read.bytes)} B returned` : "nothing returned"}
      </span>
    </div>
  );
}

export function MyLicenses({ state, markets, names, info }: { state: BackStateHandle; markets: (MarketView | null)[]; names: string[]; info: PublicRoundInfo }) {
  const d = state.data;
  return (
    <Panel aria-label="Your licenses">
      <PanelHeader title="Your licenses · private to you and the author" meta={d ? `${d.backer.name} ${shortAddr(d.backer.owner)}` : undefined} />
      {d ? (
        <div className="num flex flex-wrap gap-x-5 gap-y-1 border-b border-edge px-3 py-2 text-[11px] text-fg-dim">
          <span>
            SOL on L1 <span className="text-fg-muted">{formatSol(d.backer.solL1)}</span>
          </span>
          <span>
            USDC on L1 <span className="text-fg-muted">{formatUsd(d.backer.usdcL1)}</span>
          </span>
          <span>
            USDC on the rollup <span className="text-fg-muted">{d.backer.usdcEr === null ? "no deposit yet" : formatUsd(d.backer.usdcEr)}</span>
          </span>
          <span className="font-sans sm:ml-auto">key held by the local server in {d.backer.keyFile}</span>
        </div>
      ) : null}
      {!d && state.loading ? (
        <div className="space-y-2 p-3" aria-busy="true">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : !d && state.error ? (
        <p role="alert" className="px-3 py-6 text-sm text-loss">
          Could not read the web backer: {state.error}. Retrying.
        </p>
      ) : d && !d.licenses.length ? (
        <div className="px-3 py-8 text-center">
          <p className="text-sm text-fg-muted">No licenses yet in this round.</p>
          <p className="mt-1 text-xs text-fg-dim">Pick a strategy above and back it. Its trades on your margin show up here every tick.</p>
        </div>
      ) : d ? (
        <div>
          {d.licenses.map((l) => (
            <LicenseCard key={l.license} l={l} markets={markets} names={names} info={info} />
          ))}
        </div>
      ) : null}
      {d?.read ? <ReadLine read={d.read} /> : null}
    </Panel>
  );
}
