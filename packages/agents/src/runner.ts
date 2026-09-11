#!/usr/bin/env ts-node
/**
 * BLACKBOX agent runner: puts LLM traders (and a scripted baseline) into a
 * round through the BLACKBOX MCP server, one server process per agent.
 *
 *   ts-node --transpile-only packages/agents/src/runner.ts \
 *     [--providers claude,openai,gemini,scripted] [--round-file .mb/round-local.json] \
 *     [--interval-secs 45] [--max-steps N] [--margin 100] [--adopt <bot name>] [--keypair <path>]
 *
 * Providers run only when their key is present (ANTHROPIC_API_KEY, OPENAI_API_KEY,
 * GEMINI_API_KEY); `scripted` always runs. Models: BLACKBOX_CLAUDE_MODEL (default
 * claude-sonnet-5), BLACKBOX_OPENAI_MODEL, BLACKBOX_GEMINI_MODEL.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Agent, Mutex, type AgentOutcome } from "./agent";
import { buildSystemPrompt } from "./prompt";
import { ClaudeBrain } from "./providers/claude";
import { GeminiBrain } from "./providers/gemini";
import { OpenAIBrain } from "./providers/openai";
import { ScriptedBrain } from "./providers/scripted";
import { defaultRoundFile, readRoundFile, repoRoot } from "./round";
import { consoleLog } from "./transcript";
import type { Brain } from "./types";

export const PROVIDERS = ["claude", "openai", "gemini", "scripted"] as const;
export type ProviderId = (typeof PROVIDERS)[number];

export interface RunnerArgs {
  providers: ProviderId[];
  roundFile: string;
  intervalSecs: number;
  maxSteps: number;
  margin: number;
  minMargin: number;
  maxMargin: number;
  adopt?: string;
  keypair?: string;
  name?: string;
  quiet: boolean;
  verboseServer: boolean;
  mcpCommand?: string[];
}

const HELP = `BLACKBOX agent runner

Options
  --providers <list>     comma list of claude,openai,gemini,scripted
                         (default: every provider with an API key, plus scripted)
  --round-file <path>    round state file (default .mb/round-$BLACKBOX_CLUSTER.json, cluster local)
  --interval-secs <n>    seconds between live decision loops (default 45)
  --max-steps <n>        stop each agent after n lifecycle steps (join, enter, each live loop)
  --margin <usdc>        default margin for scripted entries and the LLM's suggestion (default 100)
  --min-margin <usdc>    lowest margin an LLM may choose (default 50)
  --max-margin <usdc>    highest margin an LLM may choose (default 250)
  --name <name>          agent name (BLACKBOX_AGENT_NAME) when running one provider
  --keypair <path>       agent keypair (BLACKBOX_KEYPAIR) when running one provider
  --adopt <entrant>      run one provider as an existing entrant from the round file
                         (uses its secret key; local testing on a round already live)
  --mcp-command "<cmd>"  MCP server launch command (default: ts-node packages/mcp-server/src/index.ts)
  --verbose-server       echo MCP server stderr
  --quiet                no live log (transcripts are still written)
`;

export function hasKey(p: ProviderId, env: NodeJS.ProcessEnv = process.env): boolean {
  switch (p) {
    case "claude": return !!(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
    case "openai": return !!env.OPENAI_API_KEY;
    case "gemini": return !!(env.GEMINI_API_KEY || env.GOOGLE_API_KEY);
    case "scripted": return true;
  }
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): RunnerArgs | "help" {
  const a: RunnerArgs = {
    providers: [],
    roundFile: env.BLACKBOX_ROUND_FILE || defaultRoundFile(env.BLACKBOX_CLUSTER || "local"),
    intervalSecs: 45,
    maxSteps: Infinity,
    margin: 100,
    minMargin: 50,
    maxMargin: 250,
    quiet: false,
    verboseServer: false,
  };
  let providersGiven = false;
  const need = (i: number, flag: string) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
    return v;
  };
  const pos = (v: string, flag: string) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} must be a positive number`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    const [flag, inline] = raw.includes("=") ? [raw.slice(0, raw.indexOf("=")), raw.slice(raw.indexOf("=") + 1)] : [raw, undefined];
    const val = () => (inline !== undefined ? inline : need(i++, flag));
    switch (flag) {
      case "-h": case "--help": return "help";
      case "--providers": {
        providersGiven = true;
        const list = val().split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
        for (const p of list) if (!(PROVIDERS as readonly string[]).includes(p)) throw new Error(`unknown provider ${p} (expected ${PROVIDERS.join(", ")})`);
        a.providers = [...new Set(list)] as ProviderId[];
        break;
      }
      case "--round-file": a.roundFile = path.resolve(val()); break;
      case "--interval-secs": a.intervalSecs = pos(val(), flag); break;
      case "--max-steps": a.maxSteps = Math.floor(pos(val(), flag)); break;
      case "--margin": a.margin = pos(val(), flag); break;
      case "--min-margin": a.minMargin = pos(val(), flag); break;
      case "--max-margin": a.maxMargin = pos(val(), flag); break;
      case "--adopt": a.adopt = val(); break;
      case "--keypair": a.keypair = path.resolve(val()); break;
      case "--name": a.name = val(); break;
      case "--mcp-command": a.mcpCommand = val().trim().split(/\s+/); break;
      case "--quiet": a.quiet = true; break;
      case "--verbose-server": a.verboseServer = true; break;
      default: throw new Error(`unknown option ${raw}`);
    }
  }
  if (!providersGiven) a.providers = PROVIDERS.filter((p) => hasKey(p, env));
  if (a.minMargin > a.maxMargin) throw new Error("--min-margin exceeds --max-margin");
  if (a.margin < a.minMargin || a.margin > a.maxMargin) throw new Error(`--margin must be within [${a.minMargin}, ${a.maxMargin}]`);
  if ((a.adopt || a.keypair || a.name) && a.providers.length !== 1) throw new Error("--adopt, --keypair and --name need exactly one provider (use --providers)");
  if (a.adopt && a.keypair) throw new Error("use either --adopt or --keypair");
  return a;
}

export function makeBrain(p: ProviderId): Brain {
  switch (p) {
    case "claude": return new ClaudeBrain();
    case "openai": return new OpenAIBrain();
    case "gemini": return new GeminiBrain();
    case "scripted": return new ScriptedBrain();
  }
}

/** Write an existing entrant's secret key (from the round file) to a private temp keypair file. */
export function adoptKeypair(roundFile: string, name: string): { file: string; owner: string; name: string } {
  const rf = readRoundFile(roundFile);
  const all = [...(rf.entrants ?? []), ...(rf.external ?? [])];
  const e = all.find((x) => x.name.toLowerCase() === name.toLowerCase() || x.owner === name);
  if (!e) throw new Error(`no entrant named ${name} in ${roundFile} (have: ${all.map((x) => x.name).join(", ")})`);
  if (!Array.isArray(e.secretKey) || e.secretKey.length !== 64) throw new Error(`entrant ${e.name} has no secret key in the round file`);
  const dir = path.join(os.tmpdir(), "blackbox-agents");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `round${rf.roundId}-${e.name}.json`);
  fs.writeFileSync(file, JSON.stringify(e.secretKey), { mode: 0o600 });
  return { file, owner: e.owner, name: e.name };
}

export async function main(argv = process.argv.slice(2)): Promise<AgentOutcome[]> {
  let args: RunnerArgs | "help";
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}\n\n${HELP}`);
    process.exitCode = 2;
    return [];
  }
  if (args === "help") {
    console.log(HELP);
    return [];
  }
  if (!fs.existsSync(args.roundFile)) {
    console.error(`round file not found: ${args.roundFile}\nStart a round first: CLUSTER=local pnpm exec ts-node --transpile-only scripts/run-round.ts`);
    process.exitCode = 1;
    return [];
  }
  const log = consoleLog(args.quiet);
  const rf = readRoundFile(args.roundFile);
  const skipped = PROVIDERS.filter((p) => p !== "scripted" && !args.providers.includes(p) && !hasKey(p));
  console.log(`BLACKBOX agents on round #${rf.roundId} (${rf.cluster}, ${rf.mode}, phase ${rf.phase}) providers: ${args.providers.join(", ") || "none"}${skipped.length ? `; no key for ${skipped.join(", ")}` : ""}`);
  for (const p of args.providers) if (p !== "scripted" && !hasKey(p)) console.log(`warning: ${p} has no API key in the environment; its requests will likely fail`);

  const stop = { requested: false };
  let sigints = 0;
  process.on("SIGINT", () => {
    sigints++;
    stop.requested = true;
    if (sigints > 1) process.exit(130);
    console.log("\nstopping agents after their current step (Ctrl-C again to exit now)");
  });

  let keypair = args.keypair;
  let adoptedName: string | undefined;
  if (args.adopt) {
    const k = adoptKeypair(args.roundFile, args.adopt);
    keypair = k.file;
    adoptedName = k.name;
    console.log(`adopting entrant ${k.name} (${k.owner})`);
  }

  const systemPrompt = buildSystemPrompt();
  const joinLock = new Mutex();
  const agents: Promise<AgentOutcome>[] = [];
  for (const p of args.providers) {
    let brain: Brain;
    try {
      brain = makeBrain(p);
    } catch (e) {
      console.error(`${p}: cannot start (${e instanceof Error ? e.message : String(e)})`);
      continue;
    }
    const agent = new Agent({
      brain,
      agentName: args.name ?? adoptedName ?? `${p}-quant`,
      roundFile: args.roundFile,
      systemPrompt,
      intervalSecs: args.intervalSecs,
      maxSteps: args.maxSteps,
      marginUsdc: args.margin,
      marginRange: { min: args.minMargin, max: args.maxMargin },
      keypair,
      log,
      joinLock,
      serverCommand: args.mcpCommand,
      stop,
      verboseServer: args.verboseServer,
    });
    agents.push(agent.run());
  }
  const outcomes = await Promise.all(agents);
  console.log("\nsummary");
  for (const o of outcomes) {
    const last = o.memory.decisions[o.memory.decisions.length - 1];
    console.log(`  ${o.provider.padEnd(9)} ${o.agent.padEnd(16)} steps ${String(o.steps).padEnd(4)} swaps ${o.memory.swaps}  ${o.reason}`);
    if (last) console.log(`            last decision: ${last.action}: ${last.explanation}`);
    if (o.transcript) console.log(`            transcript ${path.relative(repoRoot(), o.transcript)}`);
  }
  if (outcomes.some((o) => o.reason.startsWith("error"))) process.exitCode = 1;
  return outcomes;
}

if (require.main === module) {
  main().then(() => process.exit(process.exitCode ?? 0)).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
