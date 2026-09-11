/**
 * Transcripts: JSON lines in runs/<provider>-round<id>.jsonl (tool calls,
 * result summaries, decisions, tx links), plus a compact live console log.
 */
import * as fs from "fs";
import * as path from "path";

export type TranscriptEvent =
  | { type: "start"; model: string; roundAddress: string; cluster: string; keypair?: string }
  | { type: "phase"; phase: string; note?: string }
  | { type: "tool_call"; by: "runner" | "model"; tool: string; args: Record<string, unknown> }
  | { type: "tool_result"; tool: string; ok: boolean; summary: string; ms: number; tx?: string[] }
  | { type: "llm"; turn: number; stop: string | null; usage?: Record<string, unknown>; text?: string }
  | { type: "strategy"; label: string; marginUsdc: number; rationale: string; source: string }
  | { type: "decision"; loop: number; tick?: number; action: string; explanation: string; version?: number | null; context?: Record<string, string> }
  | { type: "tx"; tool: string; links: string[] }
  | { type: "error"; where: string; message: string }
  | { type: "stop"; reason: string };

export const RUNS_DIR = path.resolve(__dirname, "../runs");

export class Transcript {
  readonly file: string;

  constructor(readonly provider: string, readonly roundId: number, readonly agent: string, dir = RUNS_DIR) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, `${provider}-round${roundId}.jsonl`);
  }

  write(ev: TranscriptEvent): void {
    const line = JSON.stringify({ ...ev, t: new Date().toISOString(), agent: this.agent, provider: this.provider, round: this.roundId });
    fs.appendFileSync(this.file, line + "\n");
  }
}

export interface LiveLog {
  (provider: string, phase: string, msg: string): void;
}

const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length));

export function consoleLog(quiet = false): LiveLog {
  return (provider, phase, msg) => {
    if (quiet) return;
    const ts = new Date().toISOString().slice(11, 19);
    process.stdout.write(`${ts} ${pad(provider, 8)} ${pad(phase, 12)} ${msg}\n`);
  };
}
