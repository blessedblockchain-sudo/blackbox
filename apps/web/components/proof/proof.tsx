"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { MotionConfig, motion } from "framer-motion";
import { ShieldCheck, ShieldAlert } from "lucide-react";
import type { ProofAccess, ProofResponse } from "../../lib/api-types";
import { useLiveRound, useNow, useRoundInfo } from "../../lib/hooks";
import { formatDuration, formatInt, formatMs, shortAddr } from "../../lib/format";
import { Badge, Button, Panel, PanelHeader, Skeleton } from "../ui";

const ACCESS: Record<ProofAccess, { tone: "gain" | "loss" | "dim" | "warn"; text: string; title: string }> = {
  read: { tone: "gain", text: "read", title: "The path returned the account's bytes." },
  blocked: { tone: "loss", text: "blocked", title: "The path returned nothing private: null, redacted, denied or all zeros." },
  info: { tone: "dim", text: "info", title: "Context for the other rows, not an attack." },
  error: { tone: "warn", text: "no answer", title: "The request failed; an outage never counts as blocked." },
};

type RunState = { status: "idle" } | { status: "running"; startedAt: number; target: string } | { status: "done"; data: ProofResponse } | { status: "error"; error: string; target: string };

function Explainer() {
  return (
    <header className="border border-edge bg-surface px-4 py-3">
      <h1 className="font-mono text-lg font-medium tracking-tight">Privacy proof</h1>
      <p className="mt-2 max-w-[92ch] text-sm leading-6 text-fg-muted">
        This runs the bx-attack matrix live against one entrant of the running round: it tries every way a rival could read that entrant&apos;s private Strategy and Position, through the TEE RPC with no
        token, a brand-new wallet&apos;s token and a rival entrant&apos;s token, in single, batch and program-wide reads, through the transaction that uploaded the code, the copies on Solana L1 and
        MagicBlock&apos;s delegation accounts. Only the owner&apos;s own token should get anything back.
      </p>
      <p className="mt-2 max-w-[92ch] text-xs leading-5 text-fg-dim">
        What it cannot show is that the enclave itself is sound. On devnet you trust Intel TDX and MagicBlock&apos;s attested TEE validator; the local stack runs MagicBlock&apos;s query-filtering service
        with the same tokens and permissions but no enclave and no attestation.{" "}
        <Link href="/disclosures#item-4" className="underline decoration-edge-strong underline-offset-4 transition-colors duration-150 hover:text-fg hover:decoration-fg-dim">
          Disclosures 4 to 6
        </Link>
      </p>
    </header>
  );
}

export function Proof() {
  const { info, error: infoError } = useRoundInfo();
  const live = useLiveRound(info, 1500);
  const [target, setTarget] = useState("");
  const [run, setRun] = useState<RunState>({ status: "idle" });
  const autoRan = useRef(false);
  const now = useNow(500);

  const entrants = useMemo(() => {
    if (!info) return [];
    const names = new Map(info.entrants.map((e) => [e.owner, e]));
    const owners = [...new Set([...(live.scoreboard?.entries.map((e) => e.owner) ?? []), ...info.entrantOwners, ...info.entrants.map((e) => e.owner)])];
    return owners.map((o) => ({ owner: o, name: names.get(o)?.name || shortAddr(o), canActAs: !!names.get(o)?.canActAs }));
  }, [info, live.scoreboard]);

  const go = async (owner: string) => {
    if (!owner) return;
    setRun({ status: "running", startedAt: Date.now(), target: owner });
    try {
      const res = await fetch("/api/proof", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner }) });
      const body = (await res.json()) as ProofResponse | { error: string };
      if (!res.ok || "error" in body) throw new Error("error" in body ? body.error : `HTTP ${res.status}`);
      setRun({ status: "done", data: body });
    } catch (e) {
      setRun({ status: "error", error: e instanceof Error ? e.message : String(e), target: owner });
    }
  };

  // Pick the first entrant and run once, so the page opens on a live result.
  useEffect(() => {
    if (!target && entrants.length) setTarget(entrants[0].owner);
    if (!autoRan.current && entrants.length) {
      autoRan.current = true;
      void go(target || entrants[0].owner);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entrants]);

  if (!info) {
    return infoError ? (
      <Panel className="px-4 py-10 text-sm text-fg-muted">Round info unavailable: {infoError}. Retrying.</Panel>
    ) : (
      <div className="flex flex-col gap-3" aria-busy="true">
        <Skeleton className="h-[150px] w-full" />
        <Skeleton className="h-[420px] w-full" />
      </div>
    );
  }

  const chosen = entrants.find((e) => e.owner === target) ?? null;
  const data = run.status === "done" ? run.data : null;
  const running = run.status === "running";
  const leaks = data ? data.rows.filter((r) => !r.pass) : [];
  const reads = data ? data.rows.filter((r) => r.access === "read" && r.pass).length : 0;
  const blocked = data ? data.rows.filter((r) => r.access === "blocked").length : 0;

  return (
    <MotionConfig reducedMotion="user">
      <div className="flex flex-col gap-3">
        <Explainer />
        <Panel aria-label="Attack matrix">
          <PanelHeader title={`Round ${info.roundId ?? "--"} · ${info.cluster}`} meta={live.round ? `${live.round.status} · tick ${formatInt(live.round.tick)}` : undefined} />
          <form
            className="flex flex-wrap items-end gap-3 border-b border-edge px-3 py-3"
            onSubmit={(e) => {
              e.preventDefault();
              void go(target);
            }}
          >
            <div>
              <label htmlFor="proof-target" className="label-caps">
                Target entrant
              </label>
              <select
                id="proof-target"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                className="mt-1 block min-h-9 min-w-56 border border-edge-strong bg-surface-2 px-2 font-mono text-xs text-fg"
              >
                {entrants.map((e) => (
                  <option key={e.owner} value={e.owner}>
                    {e.name} · {shortAddr(e.owner)}
                  </option>
                ))}
              </select>
            </div>
            <Button variant="primary" type="submit" disabled={!target || running} aria-busy={running}>
              {running ? `Attacking… ${formatDuration(now - run.startedAt)}` : "Run the attack matrix"}
            </Button>
            <p className="max-w-[60ch] text-xs text-fg-dim">
              {info.localRoutes && chosen?.canActAs
                ? `The local server holds ${chosen.name}'s key for this demo round, so the owner control rows run too: they must read, every other path must come back empty.`
                : "The server has no key for this entrant, so the owner control rows are skipped; every row that runs must come back empty."}
            </p>
          </form>

          {running ? (
            <div className="space-y-2 p-3" aria-busy="true" aria-live="polite">
              <p className="text-xs text-fg-dim">Sending about 16 read attempts to the TEE, Solana L1 and the rollup&apos;s own RPC…</p>
              {Array.from({ length: 8 }, (_, i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          ) : run.status === "error" ? (
            <div className="px-3 py-6">
              <p role="alert" className="text-sm break-words text-loss">
                The matrix did not complete: {run.error}
              </p>
              <Button className="mt-3" onClick={() => go(run.target)}>
                Run again
              </Button>
            </div>
          ) : data ? (
            <>
              <div
                className={clsx("flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-3 py-2.5 text-sm", leaks.length ? "border-loss/40 bg-loss-deep text-loss" : "border-edge text-fg")}
                aria-live="polite"
              >
                {leaks.length ? <ShieldAlert aria-hidden className="size-4" /> : <ShieldCheck aria-hidden className="size-4 text-gain" />}
                <span className="font-medium">
                  {leaks.length
                    ? `${formatInt(leaks.length)} of ${formatInt(data.rows.length)} rows did not behave as designed`
                    : `${formatInt(data.passed)} of ${formatInt(data.rows.length)} paths behave as designed`}
                </span>
                <span className="num text-xs text-fg-dim">
                  {data.targetName} · owner reads {formatInt(reads)} · blocked {formatInt(blocked)} · ran in {formatMs(data.ms)} · {new Date(data.at).toLocaleTimeString("en-US", { hour12: false })}
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[920px] text-xs">
                  <caption className="sr-only">Read attempts against {data.targetName}&apos;s private accounts</caption>
                  <thead>
                    <tr className="label-caps text-left">
                      <th scope="col" className="px-3 py-2 font-normal">
                        Path
                      </th>
                      <th scope="col" className="px-3 py-2 font-normal">
                        Who asked
                      </th>
                      <th scope="col" className="px-3 py-2 font-normal">
                        Result
                      </th>
                      <th scope="col" className="px-3 py-2 font-normal">
                        Expected
                      </th>
                      <th scope="col" className="px-3 py-2 text-right font-normal">
                        Verdict
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((r, i) => {
                      const a = ACCESS[r.access];
                      return (
                        <motion.tr
                          key={`${r.path}-${i}`}
                          initial={{ opacity: 0, y: 4 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ duration: 0.22, delay: i * 0.035, ease: [0.25, 1, 0.5, 1] }}
                          className={clsx("border-t border-edge align-top", !r.pass && "bg-loss-deep/60")}
                        >
                          <td className="px-3 py-2">
                            <div className="font-mono text-[12px] text-fg">{r.path}</div>
                            <div className="mt-0.5 font-mono text-[11px] break-all text-fg-faint">{r.request}</div>
                          </td>
                          <td className="px-3 py-2 text-fg-muted">{r.who}</td>
                          <td className="px-3 py-2">
                            <div className="flex items-start gap-2">
                              <Badge tone={a.tone} title={a.title} className="shrink-0">
                                {a.text}
                              </Badge>
                              <span className="font-mono text-[11px] break-words text-fg-muted">{r.result}</span>
                            </div>
                          </td>
                          <td className="px-3 py-2 text-fg-dim">{r.expected}</td>
                          <td className="px-3 py-2 text-right">
                            <Badge tone={r.pass ? "neutral" : "loss"}>{r.pass ? "pass" : "fail"}</Badge>
                          </td>
                        </motion.tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <footer className="flex flex-wrap gap-x-5 gap-y-1 border-t border-edge px-3 py-2 text-[11px] text-fg-dim">
                <span>
                  <Badge tone="gain">read</Badge> the path returned the account&apos;s bytes
                </span>
                <span>
                  <Badge tone="loss">blocked</Badge> nothing private came back
                </span>
                <span>Verdict compares each result with what a correct privacy design returns.</span>
                <span className="num sm:ml-auto">{data.rival ? `rival token: ${data.rival}` : "no rival key available"}</span>
              </footer>
            </>
          ) : (
            <p className="px-3 py-8 text-sm text-fg-dim">{entrants.length ? "Pick an entrant and run the matrix." : "No entrants yet. The matrix needs an entrant of the running round."}</p>
          )}
        </Panel>
      </div>
    </MotionConfig>
  );
}
