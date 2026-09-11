"use client";
import clsx from "clsx";
import { Check, Circle, LoaderCircle, Minus, X } from "lucide-react";
import type { BackJob, JobStep, StepLayer, StepStatus } from "../../lib/api-types";
import { formatUsdcAmount } from "../../lib/amount";
import { formatMs, shortAddr } from "../../lib/format";
import { ExtLink, Panel, PanelHeader } from "../ui";

const LAYER: Record<StepLayer, string> = { l1: "Solana L1", er: "TEE rollup", wait: "wait", local: "local file" };

const ICON: Record<StepStatus, { Icon: typeof Check; cls: string; sr: string }> = {
  done: { Icon: Check, cls: "text-gain", sr: "done" },
  skipped: { Icon: Minus, cls: "text-fg-dim", sr: "skipped" },
  error: { Icon: X, cls: "text-loss", sr: "failed" },
  running: { Icon: LoaderCircle, cls: "text-warn motion-safe:animate-spin", sr: "running" },
  pending: { Icon: Circle, cls: "text-fg-faint", sr: "not run" },
};

function StepRow({ s }: { s: JobStep }) {
  const { Icon, cls, sr } = ICON[s.status];
  return (
    <li className="flex items-start gap-3 px-3 py-2">
      <Icon aria-hidden className={clsx("mt-0.5 size-3.5 shrink-0", cls)} strokeWidth={2} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className={clsx("text-xs", s.status === "pending" ? "text-fg-dim" : "text-fg")}>{s.label}</span>
          <span className="label-caps !text-[10px]">{LAYER[s.layer]}</span>
          <span className="sr-only">: {sr}</span>
        </div>
        {s.detail ? <div className={clsx("mt-0.5 text-[11px] break-words whitespace-pre-wrap", s.status === "error" ? "text-loss" : "text-fg-dim")}>{s.detail}</div> : null}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5 pt-px">
        {s.sig && s.explorer ? (
          <ExtLink href={s.explorer} className="num text-[11px] text-fg-muted">
            {shortAddr(s.sig, 6, 4)}
          </ExtLink>
        ) : null}
        {s.ms !== undefined ? <span className="num text-[11px] text-fg-faint">{formatMs(s.ms)}</span> : null}
      </div>
    </li>
  );
}

/** Step-by-step log of one license setup, with an explorer link for every transaction. */
export function JobPanel({ job }: { job: BackJob }) {
  const finished = job.steps.filter((s) => s.status === "done" || s.status === "skipped").length;
  const sent = job.steps.filter((s) => s.sig).length;
  return (
    <Panel aria-label={`License setup for ${job.authorName}`}>
      <PanelHeader
        title={`Backing ${job.authorName} · ${formatUsdcAmount(job.margin)} USDC`}
        meta={job.status === "running" ? `${finished}/${job.steps.length} steps` : job.status === "done" ? `done · ${sent} transactions` : "failed"}
      />
      <ol aria-live="polite" className="divide-y divide-edge">
        {job.steps.map((s) => (
          <StepRow key={s.key} s={s} />
        ))}
      </ol>
      {job.status === "error" && job.error ? (
        <p role="alert" className="border-t border-loss/30 bg-loss-deep px-3 py-2 text-xs break-words whitespace-pre-wrap text-loss">
          {job.error}
        </p>
      ) : null}
      {job.status === "done" ? (
        <p className="border-t border-edge px-3 py-2 text-xs text-fg-muted">The license is live. The crank runs {job.authorName}&apos;s sealed code on your book from the next tick; follow it under Your licenses.</p>
      ) : null}
    </Panel>
  );
}
