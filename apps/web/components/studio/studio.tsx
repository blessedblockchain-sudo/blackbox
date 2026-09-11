"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CompileResult, SimOptions } from "@blackbox/compiler";
import { useHistory, useLiveRound, useRoundInfo } from "../../lib/hooks";
import { pickSeries } from "../../lib/sim-series";
import { formatInt } from "../../lib/format";
import { Badge, Panel, PanelHeader, Skeleton } from "../ui";
import { IdentityPanel } from "./identity";
import { PositionPanel, StrategyPanel } from "./reads";
import { BxlEditor, type Diagnostic } from "./editor";
import { SimPanel, type Simulate } from "./sim";
import { HotSwapPanel } from "./hot-swap";
import { useOwnerReads, type Identity } from "./use-owner";

type CompilerModule = typeof import("@blackbox/compiler");

/** Used only if the compiler package ships no examples. */
const FALLBACK_SOURCE = `# EMA trend on SOL: long above the slow average, short below.
let up = ema(SOL, 8) > ema(SOL, 21)
if up and pos(SOL) <= 0 {
  long(SOL, 30%)
} elif not up and pos(SOL) >= 0 {
  short(SOL, 30%)
}
`;

function hashSource(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16);
}

export function Studio() {
  const { info, error: infoError } = useRoundInfo();
  const live = useLiveRound(info);
  const history = useHistory(info, live);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [nonce, setNonce] = useState(0);
  const reads = useOwnerReads(identity, info?.round ?? null, info?.endpoints.tee ?? null, 1500, nonce);

  // Deep link: /studio?as=<bot name or owner> preselects a local identity.
  const preselected = useRef(false);
  useEffect(() => {
    if (preselected.current || !info?.localRoutes) return;
    preselected.current = true;
    const want = new URLSearchParams(window.location.search).get("as");
    const hit = want ? info.entrants.find((e) => e.canActAs && (e.owner === want || e.name.toLowerCase() === want.toLowerCase())) : null;
    if (hit) setIdentity({ kind: "bot", owner: hit.owner, name: hit.name });
  }, [info]);

  // Compiler: loaded on demand so a compiler failure never takes the page down.
  const [compiler, setCompiler] = useState<CompilerModule | null>(null);
  const [compilerError, setCompilerError] = useState<string | null>(null);
  useEffect(() => {
    import("@blackbox/compiler")
      .then((m) => setCompiler(m))
      .catch((e: unknown) => setCompilerError(e instanceof Error ? e.message : String(e)));
  }, []);

  const examples = useMemo(() => {
    const ex = compiler?.EXAMPLES ?? {};
    return Object.keys(ex).length ? ex : { trend: FALLBACK_SOURCE };
  }, [compiler]);
  const [exampleName, setExampleName] = useState<string>("");
  const [source, setSource] = useState<string>(FALLBACK_SOURCE);
  const touched = useRef(false);
  useEffect(() => {
    if (touched.current || !compiler) return;
    const first = Object.keys(examples)[0];
    setExampleName(first);
    setSource(examples[first]);
  }, [compiler, examples]);

  // Compile on change (debounced).
  const [result, setResult] = useState<CompileResult | null>(null);
  const [compileCrash, setCompileCrash] = useState<string | null>(null);
  const marketNames = info?.markets ?? [];
  const marketsKey = marketNames.join(",");
  useEffect(() => {
    if (!compiler || !marketsKey) return;
    const id = setTimeout(() => {
      try {
        setResult(compiler.compile(source, { markets: marketsKey.split(",") }));
        setCompileCrash(null);
      } catch (e) {
        setResult(null);
        setCompileCrash(e instanceof Error ? e.message : String(e));
      }
    }, 180);
    return () => clearTimeout(id);
  }, [compiler, source, marketsKey]);

  const diagnostics: Diagnostic[] = useMemo(
    () => [
      ...(result?.errors ?? []).map((e) => ({ ...e, severity: "error" as const })),
      ...(result?.warnings ?? []).map((e) => ({ ...e, severity: "warning" as const })),
    ],
    [result],
  );

  const round = live.round;
  const stepLimit = round?.stepLimit ?? 512;
  const bytecode = result?.ok && result.bytecode.length ? result.bytecode : null;

  const nMarkets = marketNames.length;
  const series = useMemo(
    () => pickSeries(history.store.markRows(nMarkets), live.markets.map((m) => m?.ring ?? [])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [history.version, live.markets, nMarkets],
  );
  const simOpts: SimOptions = useMemo(
    () => ({
      markets: marketNames,
      margin: reads.position?.margin || 100,
      maxLeverage: round?.markets.map((m) => m.maxLeverage),
      maintenanceBps: round?.markets.map((m) => m.maintenanceBps),
      spreadBps: round?.markets[0]?.baseSpreadBps ?? 2,
      stepLimit,
      seed: 7,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [marketsKey, reads.position?.margin, round?.markets, stepLimit],
  );

  if (!info) {
    return infoError ? (
      <Panel className="px-4 py-10 text-sm text-fg-muted">Round info unavailable: {infoError}. Retrying.</Panel>
    ) : (
      <div className="grid gap-3 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]" aria-busy="true">
        <Skeleton className="h-[520px]" />
        <Skeleton className="h-[520px]" />
      </div>
    );
  }

  const status = compilerError
    ? { tone: "loss" as const, text: "compiler unavailable" }
    : compileCrash
      ? { tone: "loss" as const, text: "compiler crashed" }
      : !result
        ? { tone: "dim" as const, text: "compiling…" }
        : result.ok
          ? { tone: result.maxSteps > stepLimit ? ("warn" as const) : ("gain" as const), text: `ok · ${formatInt(result.bytecode.length)} B · ≤${formatInt(result.maxSteps)} steps` }
          : { tone: "loss" as const, text: `${result.errors.length} error${result.errors.length === 1 ? "" : "s"}` };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h1 className="font-mono text-lg font-medium tracking-tight">Strategy studio</h1>
        <p className="text-sm text-fg-dim">
          Write BXL, backtest it on this round&apos;s marks, and hot-swap it into your sealed box. Round {info.roundId ?? "--"} · {round ? round.status : info.phase ?? "unknown"}.
        </p>
      </div>
      <div className="grid gap-3 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div className="flex min-w-0 flex-col gap-3">
          <IdentityPanel info={info} identity={identity} onChange={setIdentity} />
          <StrategyPanel reads={reads} />
          <PositionPanel reads={reads} markets={live.markets} names={marketNames} />
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          <Panel>
            <PanelHeader title="BXL editor">
              <div className="flex items-center gap-2">
                <label htmlFor="example" className="label-caps">
                  Example
                </label>
                <select
                  id="example"
                  value={exampleName}
                  onChange={(e) => {
                    touched.current = true;
                    setExampleName(e.target.value);
                    setSource(examples[e.target.value] ?? "");
                  }}
                  className="min-h-8 border border-edge bg-surface-2 px-2 font-mono text-xs text-fg"
                >
                  <option value="" disabled>
                    custom
                  </option>
                  {Object.keys(examples).map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
                <Badge tone={status.tone}>{status.text}</Badge>
              </div>
            </PanelHeader>
            <BxlEditor
              value={source}
              onChange={(v) => {
                touched.current = true;
                if (exampleName && examples[exampleName] !== v) setExampleName("");
                setSource(v);
              }}
              diagnostics={diagnostics}
            />
            {compilerError || compileCrash ? (
              <p className="px-3 py-2 text-xs text-loss" role="alert">
                {compilerError ? `Could not load @blackbox/compiler: ${compilerError}` : `Compiler error: ${compileCrash}`}
              </p>
            ) : null}
            {result?.ok ? (
              <details className="group border-t border-edge">
                <summary className="flex min-h-9 cursor-pointer items-center px-3 label-caps hover:text-fg-muted">Compiled listing ({formatInt(result.bytecode.length)} bytes)</summary>
                <pre className="num max-h-56 overflow-auto bg-void px-3 py-2 text-xs leading-5 text-fg-muted">{result.listing}</pre>
              </details>
            ) : null}
            {result?.ok && result.maxSteps > stepLimit ? (
              <p className="border-t border-edge px-3 py-2 text-xs text-warn">
                Worst-case path is {formatInt(result.maxSteps)} steps; the round&apos;s limit is {formatInt(stepLimit)}. Ticks that hit the limit fault and trade nothing.
              </p>
            ) : null}
          </Panel>
          <SimPanel
            simulate={compiler ? (compiler.simulate as Simulate) : null}
            bytecode={bytecode}
            deployed={reads.strategy?.bytecode ?? null}
            series={series.series}
            seriesSource={series.source === "history" ? `${history.source} history` : series.source === "ring" ? "on-chain ring buffer" : "none"}
            opts={simOpts}
            sourceHash={hashSource(source)}
          />
          <HotSwapPanel
            info={info}
            identity={identity}
            bytecode={bytecode}
            currentVersion={reads.strategy?.version ?? null}
            roundLive={!!round && (round.status === "live" || round.status === "open")}
            onSwapped={() => setNonce((n) => n + 1)}
          />
        </div>
      </div>
    </div>
  );
}
