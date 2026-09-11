/**
 * BLACKBOX MCP tools. Every tool returns a concise text summary, the same data
 * as JSON (second text block), and `structuredContent`. Transaction-sending
 * tools include explorer links and are serialized through Ctx.exclusive.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Keypair, PublicKey } from "@solana/web3.js";
import { z } from "zod";
import { BLACKBOX_PROGRAM_ID, pda } from "@blackbox/sdk";
import type { SimTick } from "@blackbox/compiler";
import { Ctx, TxRecord, roundEconomics } from "./context";
import { BUILTIN_NAMES, BuiltinName, builtinBytecode, compileBxl, formatErrors, referenceWithExamples, sdkListing, sha256Hex, simulateBytecode } from "./bxl";
import { appendExternal, appendLicense, isRecorded, RoundFile, resolveMarket, marketSymbol } from "./roundfile";
import {
  enumName,
  estimateEquity,
  faultName,
  fmtDuration,
  fmtPct,
  fmtPrice,
  fmtSigned,
  fmtUsd,
  fx6,
  LegView,
  ringTail,
  round,
  short,
  toBig,
  toNum,
} from "./format";

type Json = Record<string, unknown>;

export function ok(text: string, data: Json): CallToolResult {
  return { content: [{ type: "text", text }, { type: "text", text: JSON.stringify(data) }], structuredContent: data };
}

export function fail(text: string, data?: Json): CallToolResult {
  const out: CallToolResult = { isError: true, content: [{ type: "text", text }] };
  if (data) {
    out.content.push({ type: "text", text: JSON.stringify(data) });
    out.structuredContent = data;
  }
  return out;
}

/** Progress notifications (only when the client supplied a progress token). */
type Extra = { _meta?: { progressToken?: string | number }; sendNotification: (n: any) => Promise<void> };
function progress(extra: Extra | undefined, step: number, total: number, message: string) {
  const token = extra?._meta?.progressToken;
  if (token === undefined || !extra) return;
  extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: step, total, message } }).catch(() => {});
}

function guard(fn: (args: any, extra: Extra) => Promise<CallToolResult>) {
  return async (args: any, extra: Extra): Promise<CallToolResult> => {
    try {
      return await fn(args ?? {}, extra);
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      return fail(msg.length > 2000 ? `${msg.slice(0, 2000)}...` : msg);
    }
  };
}

const txLines = (txs: TxRecord[]) => txs.map((t) => `  ${t.step} [${t.layer}] ${t.link}`).join("\n");

// ------------------------------------------------------------ shared views

interface MarketView {
  index: number;
  name: string;
  symbol: string;
  mark: number;
  ema8: number;
  ema21: number;
  ema55: number;
  vol: number;
  maxLeverage: number;
  maintenanceBps: number;
  fundingRateBps: number;
  oiLong: number;
  oiShort: number;
  lastTick: number;
}

function marketViews(rf: RoundFile, r: any, mkts: any[]): MarketView[] {
  return mkts.map((m, i) => ({
    index: i,
    name: rf.markets[i] ?? `M${i}`,
    symbol: marketSymbol(rf.markets[i] ?? `M${i}`),
    mark: fx6(m.mark),
    ema8: fx6(m.ema8),
    ema21: fx6(m.ema21),
    ema55: fx6(m.ema55),
    vol: fx6(m.vol),
    maxLeverage: toNum(r.markets[i]?.maxLeverage ?? m.maxLeverage),
    maintenanceBps: toNum(r.markets[i]?.maintenanceBps ?? m.maintenanceBps),
    fundingRateBps: toNum(m.fundingRateBps),
    oiLong: fx6(m.oiLong),
    oiShort: fx6(m.oiShort),
    lastTick: toNum(m.lastTick),
  }));
}

interface ScoreRow {
  place: number;
  name: string;
  owner: string;
  equity: number;
  deposited: number;
  pnlPct: number | null;
  trades: number;
  alive: boolean;
  onchainRank: number;
  you: boolean;
}

function scoreRows(ctx: Ctx, rf: RoundFile, sb: any): ScoreRow[] {
  const names = ctx.names(rf);
  const me = ctx.me.toBase58();
  const n = toNum(sb.n);
  const rows = sb.entries.slice(0, n).map((e: any) => {
    const owner = (e.owner as PublicKey).toBase58();
    const equity = fx6(e.equity);
    const deposited = fx6(e.deposited);
    return {
      place: 0,
      name: names.get(owner) ?? short(owner),
      owner,
      equity: round(equity, 6),
      deposited: round(deposited, 6),
      pnlPct: deposited > 0 ? round(equity / deposited - 1, 6) : null,
      trades: toNum(e.trades),
      alive: toNum(e.alive) !== 0,
      onchainRank: toNum(e.rank),
      you: owner === me,
    } as ScoreRow;
  });
  rows.sort((a: ScoreRow, b: ScoreRow) => b.equity - a.equity);
  rows.forEach((row: ScoreRow, i: number) => (row.place = i + 1));
  return rows;
}

function scoreLine(s: ScoreRow): string {
  const pnl = s.pnlPct === null ? "" : ` (${fmtSigned(s.pnlPct * 100)}%)`;
  return `${String(s.place).padStart(2)}. ${s.name}${s.you ? " [you]" : ""}  ${s.equity.toFixed(2)}${pnl}  ${s.trades} trades${s.alive ? "" : "  LIQUIDATED"}`;
}

function nextStep(phase: string, me: { joined: boolean; funded: boolean }, regLeftMs: number | null): string {
  switch (phase) {
    case "registration":
      return me.joined
        ? "Joined. Wait for phase 'delegating', then call enter_round with your BXL source and margin."
        : `Registration is open${regLeftMs !== null ? ` (${fmtDuration(regLeftMs)} left)` : ""}: call join_round.`;
    case "delegating":
      if (!me.joined) return "Registration is closed; wait for the next round.";
      return me.funded ? "Entered. The round goes live shortly; your strategy will start trading." : "Call enter_round now (source + margin_usdc); the round goes live shortly.";
    case "live":
      return me.funded ? "Live. Watch read_my_position / read_scoreboard; hot_swap_strategy to change strategy." : "Round is live; entry is closed.";
    default:
      return "Round is over or settling; strategies are final.";
  }
}

/** Resolve strategy bytecode from BXL source or a named SDK builtin. */
function strategyBytecode(ctx: Ctx, rf: RoundFile, args: { source?: string; builtin?: BuiltinName; market?: string }) {
  const symbols = ctx.symbols(rf);
  if (args.source && args.source.trim()) {
    const res = compileBxl(args.source, symbols);
    if (!res.ok) throw new Error(`BXL did not compile:\n${formatErrors(res.errors)}`);
    return { bytecode: res.bytecode, origin: "bxl", maxSteps: res.maxSteps, listing: res.listing };
  }
  if (args.builtin) {
    const m = args.market ? resolveMarket(rf.markets, args.market) : 0;
    const bytecode = builtinBytecode(args.builtin, m);
    return { bytecode, origin: `builtin:${args.builtin}(${rf.markets[m]})`, maxSteps: 0, listing: sdkListing(bytecode) };
  }
  throw new Error("Provide `source` (BXL) or `builtin` (one of " + BUILTIN_NAMES.join(", ") + ").");
}

/** An author reference: scoreboard name (case-insensitive) or wallet address. */
function resolveAuthor(ctx: Ctx, rf: RoundFile, ref: string): PublicKey {
  const want = ref.trim().toLowerCase();
  for (const [owner, name] of ctx.names(rf)) if (name.toLowerCase() === want) return new PublicKey(owner);
  try {
    return new PublicKey(ref.trim());
  } catch {
    throw new Error(`Unknown author "${ref}". list_authors shows names and wallets.`);
  }
}

// ------------------------------------------------------------ registration

export function registerTools(server: McpServer, ctx: Ctx): void {
  // registerTool infers handler args from the zod shape through types that cover
  // both zod 3 and zod 4; a dozen tools exhaust tsc's heap. The SDK still
  // validates every call against inputSchema at runtime.
  const reg = server.registerTool.bind(server) as unknown as (
    name: string,
    config: {
      title?: string;
      description?: string;
      inputSchema?: Record<string, z.ZodTypeAny>;
      outputSchema?: Record<string, z.ZodTypeAny>;
      annotations?: Record<string, unknown>;
    },
    cb: (args: any, extra: any) => Promise<CallToolResult>,
  ) => void;
  const RO = { readOnlyHint: true, openWorldHint: true } as const;
  const TX = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;
  const strategyArgs = {
    source: z.string().optional().describe("BXL strategy source. Call get_bxl_reference for the language."),
    builtin: z.enum(BUILTIN_NAMES).optional().describe("Instead of `source`: a built-in SDK strategy."),
    market: z.string().optional().describe("Market for `builtin` (e.g. SOL). Default: the round's first market."),
  };

  // ---------------------------------------------------------- get_round
  reg(
    "get_round",
    {
      title: "Round status",
      description:
        "Current BLACKBOX round: phase, tick and time left, markets (mark, EMAs, vol), pot, mode, your wallet and entrant status, the public scoreboard top N, and the next step to take.",
      inputSchema: { top: z.number().int().min(1).max(64).optional().describe("Scoreboard rows to include (default 5).") },
      annotations: RO,
    },
    guard(async ({ top = 5 }) => {
      const rf = ctx.rf();
      const { data: r } = await ctx.round(rf);
      const nMarkets = toNum(r.nMarkets);
      const [mkts, sb, ent, bal] = await Promise.all([ctx.markets(rf, nMarkets), ctx.scoreboard(rf), ctx.entrant(rf), ctx.balances(rf)]);
      const status = enumName(r.status);
      const mode = enumName(r.mode);
      const tick = toNum(r.tick);
      const duration = toNum(r.durationTicks);
      const tickMs = toNum(r.tickIntervalMs) || rf.tickMs;
      const phase = rf.phase ?? status;
      const regLeftMs = phase === "registration" && rf.registrationEndsAt ? Math.max(0, rf.registrationEndsAt - Date.now()) : null;
      const timeLeftMs = status === "live" ? Math.max(0, duration - tick) * tickMs : status === "open" ? duration * tickMs : 0;
      const markets = marketViews(rf, r, mkts);
      const rows = sb ? scoreRows(ctx, rf, sb) : null;
      const mine = rows?.find((x) => x.you) ?? null;
      const e = ent?.data;
      const me = {
        wallet: ctx.me.toBase58(),
        name: ctx.name,
        solBalance: round(bal.sol, 4),
        usdcL1: bal.usdcL1,
        usdcEr: bal.usdcEr,
        joined: !!e,
        delegated: !!ent?.delegated,
        privatized: !!e?.privatized,
        deposited: e ? fx6(e.deposited) : 0,
        funded: !!e && toBig(e.deposited) > 0n,
        alive: e ? !!e.alive && (mine ? mine.alive : true) : false,
        strategyVersion: e ? toNum(e.strategyVersion) : 0,
        equity: mine?.equity ?? null,
        place: mine?.place ?? null,
      };
      // Self-heal: the runner schedules ticks for the entrants listed in the round file.
      if (me.joined && (phase === "registration" || phase === "delegating") && !isRecorded(ctx.cfg.roundFile, me.wallet)) {
        appendExternal(ctx.cfg.roundFile, { name: ctx.name, owner: me.wallet });
      }
      const eco = roundEconomics(r);
      const data = {
        round: {
          roundId: toNum(r.id),
          address: rf.round,
          cluster: ctx.cfg.cluster,
          phase,
          status,
          mode,
          tick,
          durationTicks: duration,
          tickIntervalMs: tickMs,
          timeLeftMs,
          registrationLeftMs: regLeftMs,
          entrants: toNum(r.entrantCount),
          pot: fx6(r.pot),
          entryFee: Number(eco.entryFee) / 1e6,
          minMargin: Number(eco.minMargin) / 1e6,
          maxMargin: Number(eco.maxMargin) / 1e6,
          stepLimit: eco.stepLimit,
          vrfReady: !!r.vrfReady,
          mysteryMarket: r.vrfReady ? toNum(r.mysteryMarket) : null,
        },
        markets,
        you: me,
        scoreboard: rows ? rows.slice(0, top) : null,
        scoreboardPrivate: !rows,
        next: nextStep(phase, me, regLeftMs),
      };
      const lines = [
        `Round #${data.round.roundId} (${mode}) on ${ctx.cfg.cluster}: phase ${phase}, status ${status}, tick ${tick}/${duration}` +
          (status === "live" ? `, ${fmtDuration(timeLeftMs)} left` : regLeftMs !== null ? `, registration closes in ${fmtDuration(regLeftMs)}` : ""),
        `Pot ${fmtUsd(data.round.pot)}, ${data.round.entrants} entrants, entry fee ${data.round.entryFee} USDC, margin ${data.round.minMargin}-${data.round.maxMargin} USDC, step limit ${eco.stepLimit}`,
        "Markets:",
        ...markets.map((m) => `  ${m.symbol} mark ${fmtPrice(m.mark)}  ema8 ${fmtPrice(m.ema8)}  ema21 ${fmtPrice(m.ema21)}  vol ${fmtPct(m.vol, 4)}  max ${m.maxLeverage}x`),
        `You: ${me.name} ${me.wallet}  SOL ${me.solBalance}  USDC L1 ${me.usdcL1 ?? "-"} / ER ${me.usdcEr ?? "-"}`,
        `  ${me.joined ? "joined" : "not joined"}${me.privatized ? ", private" : ""}${me.funded ? `, funded ${me.deposited} USDC` : ""}${me.joined ? (me.alive ? ", alive" : ", liquidated") : ""}${me.strategyVersion ? `, strategy v${me.strategyVersion}` : ""}${me.equity !== null ? `, equity ${me.equity.toFixed(2)} (#${me.place})` : ""}`,
        rows
          ? rows.length
            ? `Top ${Math.min(top, rows.length)}:\n${rows.slice(0, top).map((s) => "  " + scoreLine(s)).join("\n")}`
            : "Scoreboard: no rows yet (each entrant appears after its first live tick)."
          : "Scoreboard: private (dark round).",
        `Next: ${data.next}`,
      ];
      return ok(lines.join("\n"), data);
    }),
  );

  // ---------------------------------------------------------- get_market_history
  reg(
    "get_market_history",
    {
      title: "Market history",
      description: "Recent marks for one market from its on-chain ring buffer (one mark per round tick, oldest first, at most 64).",
      inputSchema: {
        market: z.string().describe("Market symbol (SOL, BTC, ETH), full name (SOL-PERP) or index."),
        n: z.number().int().min(1).max(64).optional().describe("Number of marks (default 32, max 64)."),
      },
      annotations: RO,
    },
    guard(async ({ market, n = 32 }) => {
      const rf = ctx.rf();
      const i = resolveMarket(rf.markets, market);
      const m = await ctx.read(pda.marketPda(ctx.roundKey(rf), i), "market", { fallbackL1: true });
      if (!m) throw new Error(`Market ${rf.markets[i]} not found`);
      const d = m.data;
      const marks = ringTail(d.ring, toNum(d.ringPos), toNum(d.ringLen), n).map((v) => v / 1e6);
      const lastTick = toNum(d.lastTick);
      const first = marks[0] ?? 0;
      const last = marks[marks.length - 1] ?? 0;
      const data = {
        market: rf.markets[i],
        index: i,
        n: marks.length,
        firstTick: marks.length ? lastTick - marks.length + 1 : null,
        lastTick,
        marks,
        change: first > 0 ? round(last / first - 1, 8) : 0,
        min: marks.length ? Math.min(...marks) : null,
        max: marks.length ? Math.max(...marks) : null,
        ema8: fx6(d.ema8),
        ema21: fx6(d.ema21),
        ema55: fx6(d.ema55),
        vol: fx6(d.vol),
      };
      const text =
        `${data.market}: ${marks.length} marks, ticks ${data.firstTick}..${lastTick}, ${fmtPrice(first)} -> ${fmtPrice(last)} (${fmtPct(data.change, 4)}), ` +
        `range ${data.min !== null ? fmtPrice(data.min) : "-"}..${data.max !== null ? fmtPrice(data.max) : "-"}, ema8 ${fmtPrice(data.ema8)} ema21 ${fmtPrice(data.ema21)} ema55 ${fmtPrice(data.ema55)}, vol ${fmtPct(data.vol, 4)}\n` +
        `marks: ${marks.map(fmtPrice).join(" ")}`;
      return ok(text, data);
    }),
  );

  // ---------------------------------------------------------- compile_strategy
  reg(
    "compile_strategy",
    {
      title: "Compile BXL",
      description: "Compile a BXL strategy for this round's markets. Returns errors with line:col, the bytecode size, the worst-case step count, and the disassembly listing. Nothing is sent on chain.",
      inputSchema: { source: z.string().describe("BXL source code.") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(async ({ source }) => {
      const rf = ctx.tryRf();
      const symbols = ctx.symbols(rf);
      const res = compileBxl(source, symbols);
      let stepLimit: number | null = null;
      if (rf) stepLimit = await ctx.round(rf).then((x) => toNum(x.data.stepLimit)).catch(() => null);
      const warnings: string[] = [];
      if (res.ok && stepLimit && res.maxSteps > stepLimit) warnings.push(`worst-case ${res.maxSteps} steps exceeds the round step limit ${stepLimit}; that path would fault and discard its actions`);
      const data = {
        ok: res.ok,
        errors: res.errors,
        size: res.size,
        maxSteps: res.maxSteps,
        stepLimit,
        markets: symbols,
        bytecodeHex: res.ok ? Buffer.from(res.bytecode).toString("hex") : "",
        listing: res.listing,
        warnings,
      };
      if (!res.ok) return fail(`Compile failed:\n${formatErrors(res.errors)}`, data);
      return ok(`Compiled OK: ${res.size} bytes, worst-case ${res.maxSteps} steps${stepLimit ? ` (limit ${stepLimit})` : ""}, markets ${symbols.join("/")}.${warnings.length ? `\nWarning: ${warnings.join("; ")}` : ""}\n${res.listing}`, data);
    }),
  );

  // ---------------------------------------------------------- simulate_strategy
  reg(
    "simulate_strategy",
    {
      title: "Backtest BXL",
      description:
        "Backtest a BXL strategy off-chain with the VM + perps simulator. By default replays the markets' on-chain ring buffers (up to 64 ticks); pass market_history to use your own series. Uses the round's leverage, maintenance, spread and step limit.",
      inputSchema: {
        source: z.string().describe("BXL source code."),
        market_history: z
          .record(z.string(), z.array(z.number()))
          .optional()
          .describe("Optional price series per market symbol, oldest first, e.g. {\"SOL\": [150.1, 150.3, ...]}. Markets you omit replay their ring buffer."),
        margin_usdc: z.number().positive().optional().describe("Starting margin in USDC (default 100)."),
        seed: z.number().int().optional().describe("Seed for rand() (default 7)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async ({ source, market_history, margin_usdc = 100, seed = 7 }) => {
      const rf = ctx.tryRf();
      const symbols = ctx.symbols(rf);
      const res = compileBxl(source, symbols);
      if (!res.ok) return fail(`Compile failed:\n${formatErrors(res.errors)}`, { ok: false, errors: res.errors });

      let maxLeverage = symbols.map(() => 20);
      let maintenanceBps = symbols.map(() => 300);
      let spreadBps = 2;
      let stepLimit = 512;
      let rings: number[][] = symbols.map(() => []);
      if (rf) {
        const { data: r } = await ctx.round(rf);
        const n = toNum(r.nMarkets);
        const mkts = await ctx.markets(rf, n);
        maxLeverage = mkts.map((_, i) => toNum(r.markets[i].maxLeverage));
        maintenanceBps = mkts.map((_, i) => toNum(r.markets[i].maintenanceBps));
        spreadBps = toNum(r.markets[0]?.baseSpreadBps ?? 2);
        stepLimit = toNum(r.stepLimit) || 512;
        rings = mkts.map((m) => ringTail(m.ring, toNum(m.ringPos), toNum(m.ringLen), 64).map((v) => v / 1e6));
      }
      const supplied: Record<number, number[]> = {};
      for (const [k, v] of Object.entries((market_history ?? {}) as Record<string, number[]>)) {
        const idx = symbols.findIndex((s) => s === marketSymbol(k));
        if (idx < 0) throw new Error(`market_history key "${k}" is not a market of this round (${symbols.join(", ")})`);
        if (!v.length || v.some((p) => !(p > 0))) throw new Error(`market_history.${k} must be a non-empty list of positive prices`);
        supplied[idx] = v;
      }
      const cols = symbols.map((_, i) => supplied[i] ?? rings[i] ?? []);
      const providedLens = Object.values(supplied).map((v) => v.length);
      const len = providedLens.length ? Math.max(...providedLens) : Math.min(...cols.map((c) => c.length));
      if (!len || len < 2) throw new Error("Not enough history to simulate (need at least 2 ticks). Pass market_history.");
      // Right-align every column to `len`, padding the front with its first value.
      const aligned = cols.map((c, i) => {
        if (!c.length) throw new Error(`No data for market ${symbols[i]}; pass market_history.${symbols[i]}`);
        const tail = c.slice(-len);
        return [...Array(len - tail.length).fill(tail[0]), ...tail];
      });
      const series: SimTick[] = Array.from({ length: len }, (_, t) => ({ prices: aligned.map((c) => c[t]) }));
      const sim = simulateBytecode(res.bytecode, series, { markets: symbols, margin: margin_usdc, maxLeverage, maintenanceBps, spreadBps, stepLimit, seed });
      const eq = sim.equity ?? [];
      const stride = Math.max(1, Math.ceil(eq.length / 32));
      const curve = eq.filter((_, i) => i % stride === 0 || i === eq.length - 1).map((v) => round(v, 4));
      const ret = margin_usdc > 0 ? sim.finalEquity / margin_usdc - 1 : 0;
      const data = {
        ticks: len,
        source: Object.keys(supplied).length ? "market_history (+ ring buffers for omitted markets)" : "on-chain ring buffers",
        margin: margin_usdc,
        finalEquity: round(sim.finalEquity, 6),
        return: round(ret, 6),
        trades: sim.trades,
        liquidated: sim.liquidated,
        maxDrawdown: round(sim.maxDrawdown, 6),
        sharpe: round(sim.sharpe, 4),
        faults: sim.faults.slice(0, 10),
        faultCount: sim.faults.length,
        equityCurve: curve,
        params: { maxLeverage, maintenanceBps, spreadBps, stepLimit, seed },
      };
      const text =
        `Backtest over ${len} ticks (${data.source}): ${margin_usdc} -> ${data.finalEquity.toFixed(2)} USDC (${fmtSigned(ret * 100)}%), ${sim.trades} trades, max drawdown ${fmtPct(data.maxDrawdown)}, sharpe ${data.sharpe}` +
        `${sim.liquidated ? ", LIQUIDATED" : ""}${sim.faults.length ? `, ${sim.faults.length} faulted ticks (first: ${sim.faults[0].fault} at pc ${sim.faults[0].pc}, tick ${sim.faults[0].tick})` : ""}.` +
        (len < 32 ? "\nNote: short history; treat the result as a smoke test." : "");
      return ok(text, data);
    }),
  );

  // ---------------------------------------------------------- join_round
  reg(
    "join_round",
    {
      title: "Join round",
      description:
        "Register this agent's wallet in the round (only while phase is 'registration'). On local, tops up SOL and test USDC from the faucet when needed. Sends join_round + delegate_entrant on L1 and records you in the round file so the runner cranks your ticks.",
      inputSchema: { name: z.string().max(48).optional().describe("Display name on the scoreboard (default: the agent name).") },
      annotations: TX,
    },
    guard(async ({ name }, extra) =>
      ctx.exclusive(async () => {
        const rf = ctx.rf();
        const round = ctx.roundKey(rf);
        const mint = new PublicKey(rf.mint);
        const displayName = (name && name.trim()) || ctx.name;
        const state = await ctx.entrantL1State(rf);
        const txs: TxRecord[] = [];
        if (state === "delegated") {
          const added = appendExternal(ctx.cfg.roundFile, { name: displayName, owner: ctx.me.toBase58() });
          return ok(`Already joined round #${rf.roundId} as ${ctx.me.toBase58()} (entrant delegated).${added ? " Re-recorded in the round file." : ""}\nNext: ${nextStep(rf.phase, { joined: true, funded: false }, null)}`, {
            joined: true,
            alreadyJoined: true,
            wallet: ctx.me.toBase58(),
            roundId: rf.roundId,
            txs,
          });
        }
        if (rf.phase && rf.phase !== "registration") throw new Error(`Registration is closed: round #${rf.roundId} is in phase '${rf.phase}'. join_round only works during 'registration'.`);
        const { data: r, delegated } = await ctx.round(rf);
        if (enumName(r.status) !== "open" || delegated) throw new Error(`Round #${rf.roundId} is not accepting entrants (status ${enumName(r.status)}${delegated ? ", delegated to the ER" : ""}).`);
        const eco = roundEconomics(r);
        progress(extra, 1, 4, "funding wallet");
        txs.push(...(await ctx.ensureSol(0.3)));
        txs.push(...(await ctx.ensureUsdc(rf, eco.entryFee + eco.minMargin)));
        if (state === "missing") {
          progress(extra, 2, 4, "join_round");
          txs.push(ctx.tx("join_round", await ctx.client.join(round, mint, ctx.kp), "l1"));
        }
        progress(extra, 3, 4, "delegate_entrant");
        txs.push(ctx.tx("delegate_entrant", await ctx.client.delegateEntrant(round, ctx.kp), "l1"));
        appendExternal(ctx.cfg.roundFile, { name: displayName, owner: ctx.me.toBase58() });
        progress(extra, 4, 4, "done");
        const bal = await ctx.balances(rf);
        const data = {
          joined: true,
          alreadyJoined: false,
          wallet: ctx.me.toBase58(),
          name: displayName,
          roundId: rf.roundId,
          entrant: pda.entrantPda(round, ctx.me).toBase58(),
          strategyAccount: pda.strategyPda(round, ctx.me).toBase58(),
          positionAccount: pda.positionPda(round, ctx.me).toBase58(),
          balances: bal,
          txs,
          next: "Wait for phase 'delegating', then call enter_round.",
        };
        return ok(`Joined round #${rf.roundId} as ${displayName} (${ctx.me.toBase58()}). Entrant, strategy and position accounts are delegated to the TEE validator.\n${txLines(txs)}\nNext: ${data.next}`, data);
      }),
    ),
  );

  // ---------------------------------------------------------- enter_round
  reg(
    "enter_round",
    {
      title: "Enter round",
      description:
        "After the round is delegated (phase 'delegating') and before it goes live: deposit USDC into the ER, make your Strategy and Position accounts private, upload your compiled strategy, and fund your margin (the first funding also pays the entry fee). Idempotent: completed steps are skipped.",
      inputSchema: {
        ...strategyArgs,
        margin_usdc: z.number().positive().describe("Trading margin in USDC (within the round's min/max margin)."),
      },
      annotations: TX,
    },
    guard(async (args, extra) =>
      ctx.exclusive(async () => {
        const rf = ctx.rf();
        const round = ctx.roundKey(rf);
        const mint = new PublicKey(rf.mint);
        if (rf.phase === "registration") throw new Error("The round is still in registration. Call join_round now, then enter_round once the phase is 'delegating'.");
        if (rf.phase && rf.phase !== "delegating") throw new Error(`Entry is closed: phase is '${rf.phase}'. ${rf.phase === "live" ? "If you already entered, use hot_swap_strategy." : ""}`.trim());
        const l1 = await ctx.entrantL1State(rf);
        if (l1 === "missing") throw new Error("You have not joined this round (join_round only works during registration).");
        if (l1 === "joined") throw new Error("Your entrant is not delegated yet; call join_round again to finish delegation.");
        const { data: r } = await ctx.round(rf);
        if (enumName(r.status) !== "open") throw new Error(`Round status is '${enumName(r.status)}'; funding is only possible while it is open.`);
        const eco = roundEconomics(r);
        const margin = BigInt(Math.round(args.margin_usdc * 1e6));
        const strat = strategyBytecode(ctx, rf, args);

        const total = 6;
        progress(extra, 1, total, "waiting for entrant on the ER");
        await ctx.client.waitOnEr(ctx.kp, pda.entrantPda(round, ctx.me));
        const ent = await ctx.entrant(rf);
        if (!ent) throw new Error("Entrant account is not visible on the ER yet; retry in a few seconds.");
        const deposited = toBig(ent.data.deposited);
        if (deposited + margin < eco.minMargin || deposited + margin > eco.maxMargin) {
          throw new Error(`margin_usdc must bring your deposit into [${Number(eco.minMargin) / 1e6}, ${Number(eco.maxMargin) / 1e6}] USDC (already deposited ${Number(deposited) / 1e6}).`);
        }
        const need = margin + (deposited === 0n ? eco.entryFee : 0n);
        const txs: TxRecord[] = [];
        const skipped: string[] = [];

        progress(extra, 2, total, "depositing USDC into the ER");
        const erBal = await ctx.erBalance(mint);
        if (erBal >= need) skipped.push(`deposit (ER balance ${Number(erBal) / 1e6} USDC already covers ${Number(need) / 1e6})`);
        else {
          const amount = erBal > 0n ? need - erBal : need;
          txs.push(...(await ctx.ensureSol(0.1)));
          txs.push(...(await ctx.ensureUsdc(rf, amount)));
          txs.push(ctx.tx(`deposit ${Number(amount) / 1e6} USDC to ER`, await ctx.client.depositToEr(ctx.kp, mint, amount), "l1"));
          await ctx.client.waitErBalance(ctx.kp, mint, need);
        }

        progress(extra, 3, total, "privatize_entrant");
        if (ent.data.privatized) skipped.push("privatize (already private)");
        else txs.push(ctx.tx("privatize_entrant", await ctx.client.privatize(round, ctx.kp), "er"));

        progress(extra, 4, total, "set_strategy");
        txs.push(ctx.tx("set_strategy", await ctx.client.setStrategy(round, ctx.kp, strat.bytecode), "er"));

        progress(extra, 5, total, "fund_entrant");
        txs.push(ctx.tx(`fund_entrant ${Number(margin) / 1e6} USDC${deposited === 0n ? ` (+${Number(eco.entryFee) / 1e6} entry fee)` : ""}`, await ctx.client.fund(round, mint, ctx.kp, margin), "er"));

        appendExternal(ctx.cfg.roundFile, { name: ctx.names(rf).get(ctx.me.toBase58()) ?? ctx.name, owner: ctx.me.toBase58() });
        progress(extra, 6, total, "done");
        const s = await ctx.strategy(rf);
        const p = await ctx.position(rf);
        const data = {
          entered: true,
          roundId: rf.roundId,
          strategy: { origin: strat.origin, size: strat.bytecode.length, version: s ? toNum(s.version) : null, sha256: sha256Hex(strat.bytecode) },
          margin: p ? fx6(p.margin) : Number(margin) / 1e6,
          entryFeePaid: deposited === 0n ? Number(eco.entryFee) / 1e6 : 0,
          txs,
          skipped,
          next: "The round goes live shortly. Your strategy runs every tick inside the TEE; only your wallet can read it.",
        };
        return ok(
          `Entered round #${rf.roundId}: strategy v${data.strategy.version ?? "?"} (${strat.origin}, ${strat.bytecode.length} bytes, sha256 ${data.strategy.sha256.slice(0, 16)}...), margin ${data.margin} USDC.\n${txLines(txs)}${skipped.length ? `\nSkipped: ${skipped.join("; ")}` : ""}\nNext: ${data.next}`,
          data,
        );
      }),
    ),
  );

  // ---------------------------------------------------------- hot_swap_strategy
  reg(
    "hot_swap_strategy",
    {
      title: "Hot-swap strategy",
      description: "Compile and upload a new strategy while the round is live (also allowed before it starts). The bytes travel in a private ER transaction; the new version takes effect on the next tick.",
      inputSchema: strategyArgs,
      annotations: TX,
    },
    guard(async (args) =>
      ctx.exclusive(async () => {
        const rf = ctx.rf();
        const round = ctx.roundKey(rf);
        const { data: r } = await ctx.round(rf);
        const status = enumName(r.status);
        if (status !== "live" && status !== "open") throw new Error(`Strategy updates are closed: round status is '${status}'.`);
        const ent = await ctx.entrant(rf);
        if (!ent) throw new Error("You are not an entrant of this round.");
        if (!ent.data.privatized) throw new Error("Your entrant is not privatized yet; call enter_round first.");
        const before = await ctx.strategy(rf);
        const strat = strategyBytecode(ctx, rf, args);
        const sig = await ctx.client.setStrategy(round, ctx.kp, strat.bytecode);
        let s = await ctx.strategy(rf);
        for (let i = 0; i < 6 && s && before && toNum(s.version) <= toNum(before.version); i++) {
          await new Promise((res) => setTimeout(res, 250));
          s = await ctx.strategy(rf);
        }
        const tx = ctx.tx("set_strategy", sig, "er");
        const data = {
          version: s ? toNum(s.version) : null,
          previousVersion: before ? toNum(before.version) : null,
          updatedTick: s ? toNum(s.updatedTick) : null,
          roundTick: toNum(r.tick),
          origin: strat.origin,
          size: strat.bytecode.length,
          sha256: sha256Hex(strat.bytecode),
          tx,
        };
        return ok(`Strategy v${data.version} live from tick ${data.updatedTick} (${strat.origin}, ${strat.bytecode.length} bytes, was v${data.previousVersion}).\n  set_strategy [er] ${tx.link}`, data);
      }),
    ),
  );

  // ---------------------------------------------------------- read_my_position
  reg(
    "read_my_position",
    {
      title: "My position (private)",
      description: "Authenticated TEE read of your private Position: legs, margin, realized PnL, an equity estimate at current marks, drawdown, trade count, VM steps and the last fault.",
      inputSchema: {},
      annotations: RO,
    },
    guard(async () => {
      const rf = ctx.rf();
      const { data: r } = await ctx.round(rf);
      const n = toNum(r.nMarkets);
      const [p, mkts, sb] = await Promise.all([ctx.position(rf), ctx.markets(rf, n), ctx.scoreboard(rf)]);
      if (!p) {
        const st = await ctx.entrantL1State(rf);
        const why = st === "missing" ? "you have not joined this round" : "your Position is not readable yet (it becomes readable on the ER after delegation)";
        return ok(`No position: ${why}.`, { found: false, reason: why, wallet: ctx.me.toBase58() });
      }
      const marks = mkts.map((m) => toBig(m.mark));
      const findex = mkts.map((m) => toBig(m.fundingIndex));
      const legsRaw = (p.legs as any[]).map((l) => ({ side: toNum(l.side), size: toBig(l.size), entry: toBig(l.entry), fundingIndex: toBig(l.fundingIndex) }));
      const est = estimateEquity(toBig(p.margin), toBig(p.realizedPnl), legsRaw.slice(0, n), marks, findex);
      const legs: LegView[] = [];
      legsRaw.slice(0, n).forEach((l, i) => {
        if (l.side === 0 || l.size === 0n) return;
        legs.push({
          market: rf.markets[i],
          index: i,
          side: l.side > 0 ? "long" : "short",
          notional: Number(l.size) / 1e6,
          entry: Number(l.entry) / 1e6,
          mark: Number(marks[i]) / 1e6,
          unrealizedPnl: Number(est.unrealized[i]) / 1e6,
          fundingOwed: Number(est.funding[i]) / 1e6,
        });
      });
      const equity = Number(est.equity) / 1e6;
      const peak = Math.max(fx6(p.peakEquity), equity);
      const exposure = legs.reduce((a, l) => a + l.notional, 0);
      const mine = sb ? scoreRows(ctx, rf, sb).find((x) => x.you) ?? null : null;
      const fault = faultName(toNum(p.lastFault));
      const mem = (p.mem as any[]).map(toNum);
      const data = {
        found: true,
        margin: fx6(p.margin),
        realizedPnl: fx6(p.realizedPnl),
        equityEstimate: round(equity, 6),
        scoreboardEquity: mine?.equity ?? null,
        place: mine?.place ?? null,
        peakEquity: round(peak, 6),
        drawdown: peak > 0 ? round(1 - equity / peak, 6) : 0,
        leverage: equity > 0 ? round(exposure / equity, 4) : null,
        legs,
        tradeCount: toNum(p.tradeCount),
        lastSteps: toNum(p.lastSteps),
        lastFault: fault,
        lastFaultPc: fault ? toNum(p.lastFaultPc) : null,
        liquidated: toNum(p.liquidated) !== 0,
        mem: Object.fromEntries(mem.map((v, i) => [i, v]).filter(([, v]) => v !== 0)),
        roundTick: toNum(r.tick),
      };
      const text = [
        `Position at tick ${data.roundTick}: equity ~${equity.toFixed(4)} USDC (margin ${data.margin}, realized ${fmtSigned(data.realizedPnl, 4)}), peak ${peak.toFixed(2)}, drawdown ${fmtPct(data.drawdown)}${data.liquidated ? ", LIQUIDATED" : ""}`,
        legs.length
          ? legs.map((l) => `  ${l.market} ${l.side} ${l.notional.toFixed(2)} USDC @ ${fmtPrice(l.entry)} (mark ${fmtPrice(l.mark)}, uPnL ${fmtSigned(l.unrealizedPnl, 4)}${l.fundingOwed ? `, funding ${fmtSigned(-l.fundingOwed, 4)}` : ""})`).join("\n")
          : "  flat (no open legs)",
        `  ${data.tradeCount} trades, leverage ${data.leverage ?? "-"}x, last run ${data.lastSteps} steps${fault ? `, last fault ${fault} at pc ${data.lastFaultPc}` : ", no fault"}${mine ? `, scoreboard #${mine.place} at ${mine.equity.toFixed(2)}` : ""}`,
      ].join("\n");
      return ok(text, data);
    }),
  );

  // ---------------------------------------------------------- read_my_strategy
  reg(
    "read_my_strategy",
    {
      title: "My strategy (private)",
      description: "Authenticated TEE read of your private Strategy account: version, size, step limit, the sha256 that will be published at settlement, and the disassembly listing.",
      inputSchema: {},
      annotations: RO,
    },
    guard(async () => {
      const rf = ctx.rf();
      const s = await ctx.strategy(rf);
      if (!s) {
        const st = await ctx.entrantL1State(rf);
        const why = st === "missing" ? "you have not joined this round" : "your Strategy is not readable yet";
        return ok(`No strategy: ${why}.`, { found: false, reason: why });
      }
      const len = toNum(s.len);
      const bytes = Uint8Array.from((s.bytecode as number[]).slice(0, len));
      const listing = len ? sdkListing(bytes) : "";
      const data = {
        found: true,
        version: toNum(s.version),
        size: len,
        stepLimit: toNum(s.stepLimit),
        updatedTick: toNum(s.updatedTick),
        sha256: len ? sha256Hex(bytes) : null,
        listing,
      };
      return ok(len ? `Strategy v${data.version}: ${len} bytes, set at tick ${data.updatedTick}, step limit ${data.stepLimit}, sha256 ${data.sha256}\n${listing}` : `Strategy account exists but holds no bytecode yet (v${data.version}).`, data);
    }),
  );

  // ---------------------------------------------------------- read_scoreboard
  reg(
    "read_scoreboard",
    {
      title: "Scoreboard",
      description: "Public scoreboard ranked by equity (lit rounds). Shows equity, PnL vs deposit, trade count and liquidations. Strategies and positions stay private.",
      inputSchema: { limit: z.number().int().min(1).max(64).optional().describe("Rows to return (default all).") },
      annotations: RO,
    },
    guard(async ({ limit }) => {
      const rf = ctx.rf();
      const sb = await ctx.scoreboard(rf);
      if (!sb) return ok("The scoreboard is private in this (dark) round; only the program can read it until settlement.", { private: true, entries: [] });
      const rows = scoreRows(ctx, rf, sb);
      const shown = limit ? rows.slice(0, limit) : rows;
      const data = { private: false, finalized: toNum(sb.finalized) !== 0, count: rows.length, entries: shown };
      if (!rows.length) return ok(`Scoreboard, round #${rf.roundId}: no rows yet (each entrant appears after its first live tick).`, data);
      return ok(`Scoreboard, round #${rf.roundId} (${rows.length} entrants${data.finalized ? ", final" : ""}):\n${shown.map(scoreLine).join("\n")}`, data);
    }),
  );

  // ---------------------------------------------------------- privacy_check
  reg(
    "privacy_check",
    {
      title: "Privacy check",
      description: "Demonstrates that your Strategy and Position are private: reads them through a fresh random wallet's TEE token and with no token (both must return null) and through your own token (must return data).",
      inputSchema: {},
      annotations: RO,
    },
    guard(async () => {
      const rf = ctx.rf();
      const round = ctx.roundKey(rf);
      const stratKey = pda.strategyPda(round, ctx.me);
      const posKey = pda.positionPda(round, ctx.me);
      const st = await ctx.entrantL1State(rf);
      if (st !== "delegated") {
        const why = st === "missing" ? "you have not joined this round" : "your accounts are not delegated to the TEE yet";
        return ok(`Privacy check: INCONCLUSIVE (${why}; join and enter the round first).`, { verdict: "inconclusive", reason: why, wallet: ctx.me.toBase58() });
      }
      const stranger = Keypair.generate();
      const [ownerConn, strangerConn] = await Promise.all([ctx.client.tee(ctx.kp), ctx.client.tee(stranger)]);
      const pub = ctx.client.teePublic();
      const get = (c: typeof pub, k: PublicKey) => c.getAccountInfo(k, "processed").then((i) => (i ? i.data.length : null)).catch(() => null);
      const [os, ss, ps, op, sp, pp, l1] = await Promise.all([
        get(ownerConn, stratKey),
        get(strangerConn, stratKey),
        get(pub, stratKey),
        get(ownerConn, posKey),
        get(strangerConn, posKey),
        get(pub, posKey),
        ctx.client.base.getAccountInfo(stratKey, "confirmed").catch(() => null),
      ]);
      const reads = {
        strategy: { owner: os, stranger: ss, public: ps },
        position: { owner: op, stranger: sp, public: pp },
      };
      const l1View = l1 ? { owner: l1.owner.toBase58(), bytes: l1.data.length, bytecodeRegionZero: l1.data.subarray(96).every((b) => b === 0) } : null;
      const ownerCanRead = os !== null && op !== null;
      const othersBlocked = ss === null && ps === null && sp === null && pp === null;
      const verdict = !ownerCanRead ? "inconclusive" : othersBlocked ? "private" : "LEAK";
      const data = { verdict, wallet: ctx.me.toBase58(), stranger: stranger.publicKey.toBase58(), strategyAccount: stratKey.toBase58(), positionAccount: posKey.toBase58(), reads, l1View };
      const show = (v: number | null) => (v === null ? "null" : `${v} bytes`);
      const text = [
        `Privacy check: ${verdict === "private" ? "PRIVATE" : verdict === "LEAK" ? "LEAK DETECTED" : "INCONCLUSIVE (you have no readable strategy yet; enter the round first)"}`,
        `  Strategy ${short(stratKey.toBase58())}: you ${show(os)}, random wallet ${stranger.publicKey.toBase58().slice(0, 6)} ${show(ss)}, no token ${show(ps)}`,
        `  Position ${short(posKey.toBase58())}: you ${show(op)}, random wallet ${show(sp)}, no token ${show(pp)}`,
        l1View ? `  L1 copy of the strategy: owner ${short(l1View.owner)}, bytecode region ${l1View.bytecodeRegionZero ? "all zeros" : "NON-ZERO"}` : "  No L1 copy of the strategy.",
      ].join("\n");
      return ok(text, data);
    }),
  );

  // ---------------------------------------------------------- list_authors
  reg(
    "list_authors",
    {
      title: "Authors you can back",
      description:
        "Every entrant of the round with its public blind license price (bps of traded notional, set inside the TEE from the author's private Sharpe ratio), its number of backers, and its public equity (lit rounds). back_strategy runs one of these sealed strategies on your own margin.",
      inputSchema: {},
      annotations: RO,
    },
    guard(async () => {
      const rf = ctx.rf();
      const roundKey = ctx.roundKey(rf);
      const [{ data: r }, sb] = await Promise.all([ctx.round(rf), ctx.scoreboard(rf)]);
      const rows = sb ? scoreRows(ctx, rf, sb) : [];
      const owners = new Set<string>([
        ...rows.map((x) => x.owner),
        ...(rf.entrantOwners ?? []),
        ...(rf.entrants ?? []).map((e) => e.owner),
        ...(rf.external ?? []).map((e) => e.owner),
      ]);
      const names = ctx.names(rf);
      const me = ctx.me.toBase58();
      const found = await Promise.all(
        [...owners].map(async (owner) => {
          const ent = await ctx.read(pda.entrantPda(roundKey, new PublicKey(owner)), "entrant", { fallbackL1: true }).catch(() => null);
          if (!ent) return null;
          const row = rows.find((x) => x.owner === owner);
          return {
            name: names.get(owner) ?? short(owner),
            owner,
            feeBps: toNum(ent.data.feePriceBps),
            backers: toNum(ent.data.licenseCount),
            alive: !!ent.data.alive,
            equity: row?.equity ?? null,
            pnlPct: row?.pnlPct ?? null,
            you: owner === me,
          };
        }),
      );
      const authors = found.filter((a): a is NonNullable<typeof a> => a !== null);
      authors.sort((a, b) => b.feeBps - a.feeBps || (b.equity ?? 0) - (a.equity ?? 0));
      const feeRangeBps = [toNum(r.licenseFeeMinBps), toNum(r.licenseFeeMaxBps)];
      const text = authors.length
        ? [
            `Authors in round #${rf.roundId}. Blind price = fee in bps of traded notional, set inside the TEE from each author's private Sharpe (range ${feeRangeBps[0]}-${feeRangeBps[1]} bps):`,
            ...authors.map(
              (a) =>
                `  ${a.name}${a.you ? " [you]" : ""}  ${a.feeBps} bps  ${a.backers} backer${a.backers === 1 ? "" : "s"}` +
                `${a.equity !== null ? `  equity ${a.equity.toFixed(2)}${a.pnlPct !== null ? ` (${fmtSigned(a.pnlPct * 100)}%)` : ""}` : ""}${a.alive ? "" : "  LIQUIDATED"}  ${a.owner}`,
            ),
            "Back one with back_strategy {author, margin_usdc}.",
          ].join("\n")
        : "No entrants yet.";
      return ok(text, { roundId: rf.roundId, feeRangeBps, authors });
    }),
  );

  // ---------------------------------------------------------- back_strategy
  reg(
    "back_strategy",
    {
      title: "Back a strategy (blind license)",
      description:
        "License another entrant's sealed strategy while the round is live: the TEE runs the author's private code against YOUR margin every tick, and you never see the code. The fee (bps of traded notional) is the author's blind price at activation, paid to the author when the round settles; the rest comes back to you. Sends open_license + delegate_license on L1, deposits USDC into the ER, then activate_license and schedules the license's crank task on the ER. Idempotent.",
      inputSchema: {
        author: z.string().describe("Author to back: scoreboard name or wallet address (see list_authors)."),
        margin_usdc: z.number().positive().describe("Margin for your license book, in USDC (within the round's min/max margin)."),
      },
      annotations: TX,
    },
    guard(async ({ author, margin_usdc }, extra) =>
      ctx.exclusive(async () => {
        const rf = ctx.rf();
        const roundKey = ctx.roundKey(rf);
        const mint = new PublicKey(rf.mint);
        const authorKey = resolveAuthor(ctx, rf, author);
        if (authorKey.equals(ctx.me)) throw new Error("You cannot license your own strategy.");
        const { data: r } = await ctx.round(rf);
        if (enumName(r.status) !== "live") throw new Error(`Licensing runs on live rounds; round status is '${enumName(r.status)}'.`);
        const eco = roundEconomics(r);
        const margin = BigInt(Math.round(margin_usdc * 1e6));
        if (margin < eco.minMargin || margin > eco.maxMargin) throw new Error(`margin_usdc must be within [${Number(eco.minMargin) / 1e6}, ${Number(eco.maxMargin) / 1e6}] USDC.`);
        const lic = pda.licensePda(roundKey, ctx.me, authorKey);
        const txs: TxRecord[] = [];
        const skipped: string[] = [];
        const total = 6;

        progress(extra, 1, total, "open_license");
        if (!(await ctx.client.base.getAccountInfo(lic, "confirmed"))) {
          txs.push(...(await ctx.ensureSol(0.3)));
          txs.push(ctx.tx("open_license", await ctx.client.openLicense(roundKey, mint, ctx.kp, authorKey), "l1"));
        } else skipped.push("open_license (exists)");

        progress(extra, 2, total, "delegate_license");
        const l1 = await ctx.client.base.getAccountInfo(lic, "confirmed");
        if (l1 && l1.owner.equals(BLACKBOX_PROGRAM_ID)) txs.push(ctx.tx("delegate_license", await ctx.client.delegateLicense(roundKey, ctx.kp, authorKey), "l1"));
        else skipped.push("delegate_license (already delegated)");

        progress(extra, 3, total, "depositing USDC into the ER");
        const erBal = await ctx.erBalance(mint);
        if (erBal >= margin) skipped.push(`deposit (ER balance ${Number(erBal) / 1e6} USDC covers it)`);
        else {
          const amount = erBal > 0n ? margin - erBal : margin;
          txs.push(...(await ctx.ensureUsdc(rf, amount)));
          txs.push(ctx.tx(`deposit ${Number(amount) / 1e6} USDC to ER`, await ctx.client.depositToEr(ctx.kp, mint, amount), "l1"));
          await ctx.client.waitErBalance(ctx.kp, mint, margin);
        }

        progress(extra, 4, total, "activate_license");
        await ctx.client.waitOnEr(ctx.kp, lic);
        let state: any = await ctx.client.fetchLicense(roundKey, ctx.kp, ctx.me, authorKey).catch(() => null);
        if (state && toNum(state.active) === 1) skipped.push("activate_license (already active)");
        else txs.push(ctx.tx(`activate_license ${Number(margin) / 1e6} USDC`, await ctx.client.activateLicense(roundKey, mint, ctx.kp, authorKey, margin), "er"));

        progress(extra, 5, total, "schedule_license_tick");
        const prior = (rf.licenses ?? []).find((l) => l.buyer === ctx.me.toBase58() && l.author === authorKey.toBase58());
        let scheduled = !!prior && prior.scheduled !== false;
        if (scheduled) skipped.push("schedule (already scheduled)");
        else {
          try {
            const feeds = rf.feeds.map((f) => new PublicKey(f));
            const taskId = Math.floor(Math.random() * 1_000_000_000);
            txs.push(ctx.tx("schedule_license_tick", await ctx.client.scheduleLicenseTick(roundKey, ctx.me, authorKey, feeds, taskId, ctx.kp), "er"));
            scheduled = true;
          } catch (e) {
            skipped.push(`schedule_license_tick (${String((e as Error)?.message ?? e).slice(0, 120)}); the round runner will schedule it`);
          }
        }
        appendLicense(ctx.cfg.roundFile, { name: ctx.name, buyer: ctx.me.toBase58(), author: authorKey.toBase58(), bot: false, scheduled });
        progress(extra, 6, total, "done");

        state = await ctx.client.fetchLicense(roundKey, ctx.kp, ctx.me, authorKey).catch(() => null);
        const authorName = ctx.names(rf).get(authorKey.toBase58()) ?? short(authorKey.toBase58());
        const data = {
          license: lic.toBase58(),
          author: authorKey.toBase58(),
          authorName,
          margin: state ? fx6(state.margin) : Number(margin) / 1e6,
          feeBps: state ? toNum(state.feeBps) : null,
          active: state ? toNum(state.active) === 1 : false,
          scheduled,
          txs,
          skipped,
          next: "Your license book trades the author's sealed strategy every tick. Track it with read_my_licenses; it settles when the round ends (fees to the author, the rest back to you).",
        };
        return ok(
          `Backing ${authorName} with ${data.margin} USDC at ${data.feeBps ?? "?"} bps (locked at activation). License ${short(data.license)} is readable only by you and the author.\n${txLines(txs)}${skipped.length ? `\nSkipped: ${skipped.join("; ")}` : ""}\nNext: ${data.next}`,
          data,
        );
      }),
    ),
  );

  // ---------------------------------------------------------- read_my_licenses
  reg(
    "read_my_licenses",
    {
      title: "My licenses (private)",
      description:
        "Authenticated TEE reads of the licenses you bought (your book running someone else's sealed strategy) and the ones sold on your strategy: margin, equity estimate, realized PnL, fees accrued to the author, locked fee, trades and open legs.",
      inputSchema: {},
      annotations: RO,
    },
    guard(async () => {
      const rf = ctx.rf();
      const roundKey = ctx.roundKey(rf);
      const me = ctx.me.toBase58();
      const recs = (rf.licenses ?? []).filter((l) => l.buyer === me || l.author === me);
      if (!recs.length) return ok("No licenses bought or sold by this wallet in this round.", { licenses: [] });
      const { data: r } = await ctx.round(rf);
      const n = toNum(r.nMarkets);
      const mkts = await ctx.markets(rf, n);
      const marks = mkts.map((m) => toBig(m.mark));
      const findex = mkts.map((m) => toBig(m.fundingIndex));
      const names = ctx.names(rf);
      const views = await Promise.all(
        recs.map(async (l) => {
          const buyer = new PublicKey(l.buyer);
          const author = new PublicKey(l.author);
          const head = {
            role: l.buyer === me ? ("bought" as const) : ("sold" as const),
            license: pda.licensePda(roundKey, buyer, author).toBase58(),
            buyerName: names.get(l.buyer) ?? l.name ?? short(l.buyer),
            authorName: names.get(l.author) ?? short(l.author),
          };
          const lic: any = await ctx.client.fetchLicense(roundKey, ctx.kp, buyer, author).catch(() => null);
          if (!lic) return { ...head, readable: false };
          const legsRaw = (lic.legs as any[]).map((x) => ({ side: toNum(x.side), size: toBig(x.size), entry: toBig(x.entry), fundingIndex: toBig(x.fundingIndex) }));
          const est = estimateEquity(toBig(lic.margin), toBig(lic.realizedPnl), legsRaw.slice(0, n), marks, findex);
          const legs = legsRaw
            .slice(0, n)
            .map((x, i) => (x.side === 0 || x.size === 0n ? null : `${rf.markets[i]} ${x.side > 0 ? "long" : "short"} ${(Number(x.size) / 1e6).toFixed(2)}`))
            .filter((x): x is string => x !== null);
          const ran = toNum(lic.ranTick);
          return {
            ...head,
            readable: true,
            active: toNum(lic.active) === 1,
            margin: fx6(lic.margin),
            equityEstimate: round(Number(est.equity) / 1e6, 6),
            realizedPnl: fx6(lic.realizedPnl),
            feesAccrued: fx6(lic.accruedFees),
            feeBps: toNum(lic.feeBps),
            trades: toNum(lic.tradeCount),
            liquidated: toNum(lic.liquidated) !== 0,
            lastTick: ran > 0 ? ran - 1 : null,
            legs,
          };
        }),
      );
      const lines = views.map((v: any) =>
        !v.readable
          ? `  ${v.buyerName} -> ${v.authorName}: not readable yet`
          : `  ${v.role === "bought" ? `you back ${v.authorName}` : `${v.buyerName} backs you`}: equity ~${v.equityEstimate.toFixed(2)} on ${v.margin} USDC, realized ${fmtSigned(v.realizedPnl, 4)}, fees ${v.feesAccrued.toFixed(4)} USDC at ${v.feeBps} bps, ${v.trades} trades` +
            `${v.liquidated ? ", LIQUIDATED" : ""}${v.legs.length ? `, open: ${v.legs.join(", ")}` : ", flat"}${v.lastTick !== null ? `, last tick ${v.lastTick}` : ""}`,
      );
      return ok(`Licenses in round #${rf.roundId}:\n${lines.join("\n")}`, { licenses: views });
    }),
  );

  // ---------------------------------------------------------- read_chat / post_chat
  reg(
    "read_chat",
    {
      title: "Round chat",
      description: "Recent messages from the public round chat, an ephemeral account that exists only on the ER (sponsored by the round). Anyone can read it.",
      inputSchema: { n: z.number().int().min(1).max(32).optional().describe("Messages to return, newest last (default 16).") },
      annotations: RO,
    },
    guard(async ({ n = 16 }) => {
      const rf = ctx.rf();
      const names = ctx.names(rf);
      const msgs = await ctx.client.fetchChat(ctx.roundKey(rf));
      const messages = msgs.slice(-n).map((m) => {
        const author = m.author.toBase58();
        return { author, name: names.get(author) ?? short(author), tick: m.tick, text: m.text, you: author === ctx.me.toBase58() };
      });
      const text = messages.length ? `Round #${rf.roundId} chat:\n${messages.map((m) => `  [tick ${m.tick}] ${m.name}${m.you ? " (you)" : ""}: ${m.text}`).join("\n")}` : "The round chat is empty.";
      return ok(text, { messages });
    }),
  );

  reg(
    "post_chat",
    {
      title: "Post to the round chat",
      description: "Post one short public message (1-79 printable characters) to the round chat while the round is open or live. Everyone can read it, so never reveal strategy details.",
      inputSchema: { text: z.string().min(1).max(79).describe("Message text.") },
      annotations: TX,
    },
    guard(async ({ text }) =>
      ctx.exclusive(async () => {
        const rf = ctx.rf();
        const clean = String(text).replace(/[ -]/g, " ").trim();
        if (!clean || Buffer.byteLength(clean) > 79) throw new Error("text must be 1-79 bytes after removing control characters.");
        const tx = ctx.tx("post_chat", await ctx.client.postChat(ctx.roundKey(rf), ctx.kp, clean), "er");
        return ok(`Posted to the round #${rf.roundId} chat: "${clean}"\n  post_chat [er] ${tx.link}`, { text: clean, tx });
      }),
    ),
  );

  // ---------------------------------------------------------- get_bxl_reference
  reg(
    "get_bxl_reference",
    {
      title: "BXL reference",
      description: "The BXL strategy language reference (syntax, actions, functions, runtime rules) with example programs.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(async () => {
      const rf = ctx.tryRf();
      const text = `${referenceWithExamples()}\nMarkets in the current round: ${ctx.symbols(rf).join(", ")}\n`;
      return ok(text, { markets: ctx.symbols(rf), builtins: [...BUILTIN_NAMES] });
    }),
  );
}
