/**
 * Environment configuration and wallet loading for the BLACKBOX MCP server.
 *
 *   BLACKBOX_CLUSTER         local | devnet (default local)
 *   BLACKBOX_KEYPAIR         path to the agent's keypair JSON (64-byte array)
 *   BLACKBOX_AGENT_NAME      if BLACKBOX_KEYPAIR is unset: create or reuse .mb/agents/<name>.json
 *   BLACKBOX_ROUND_FILE      default <repo>/.mb/round-<cluster>.json
 *   BLACKBOX_FAUCET_KEYPAIR  local only: admin keypair that sends SOL and mints test USDC
 *                            (falls back to ~/.config/solana/id.json on local when present)
 *   BLACKBOX_AGENTS_DIR      where named agent keypairs live (default <repo>/.mb/agents)
 */
import { Keypair } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export type ClusterName = "local" | "devnet";

export interface Config {
  cluster: ClusterName;
  repoRoot: string;
  roundFile: string;
  keypairPath: string;
  /** True when the keypair file was created by this process. */
  keypairCreated: boolean;
  agentName: string;
  faucetPath: string | null;
}

/** Walk up from `start` to the directory holding pnpm-workspace.yaml. */
export function findRepoRoot(start: string = __dirname): string {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return path.resolve(__dirname, "../../..");
    dir = up;
  }
}

export function sanitizeName(name: string): string {
  const s = name.trim().replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return s || "agent";
}

export function loadKeypair(file: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const bytes = Array.isArray(raw) ? raw : raw.secretKey;
  if (!Array.isArray(bytes) || bytes.length !== 64) throw new Error(`${file} is not a 64-byte keypair JSON array`);
  return Keypair.fromSecretKey(Uint8Array.from(bytes));
}

export function saveKeypair(file: string, kp: Keypair): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
}

function expandHome(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cluster = (env.BLACKBOX_CLUSTER || "local").trim() as ClusterName;
  if (cluster !== "local" && cluster !== "devnet") throw new Error(`BLACKBOX_CLUSTER must be local or devnet, got "${cluster}"`);
  const repoRoot = findRepoRoot();
  const roundFile = path.resolve(expandHome(env.BLACKBOX_ROUND_FILE || path.join(repoRoot, `.mb/round-${cluster}.json`)));

  let keypairPath: string;
  let agentName: string;
  if (env.BLACKBOX_KEYPAIR) {
    keypairPath = path.resolve(expandHome(env.BLACKBOX_KEYPAIR));
    agentName = env.BLACKBOX_AGENT_NAME ? sanitizeName(env.BLACKBOX_AGENT_NAME) : "";
  } else {
    agentName = sanitizeName(env.BLACKBOX_AGENT_NAME || "agent");
    const dir = path.resolve(expandHome(env.BLACKBOX_AGENTS_DIR || path.join(repoRoot, ".mb/agents")));
    keypairPath = path.join(dir, `${agentName}.json`);
  }
  let keypairCreated = false;
  if (!fs.existsSync(keypairPath)) {
    if (env.BLACKBOX_KEYPAIR) throw new Error(`BLACKBOX_KEYPAIR ${keypairPath} does not exist`);
    saveKeypair(keypairPath, Keypair.generate());
    keypairCreated = true;
  }

  let faucetPath: string | null = null;
  if (cluster === "local") {
    const candidate = env.BLACKBOX_FAUCET_KEYPAIR ? path.resolve(expandHome(env.BLACKBOX_FAUCET_KEYPAIR)) : path.join(os.homedir(), ".config/solana/id.json");
    if (fs.existsSync(candidate)) faucetPath = candidate;
    else if (env.BLACKBOX_FAUCET_KEYPAIR) throw new Error(`BLACKBOX_FAUCET_KEYPAIR ${candidate} does not exist`);
  }
  return { cluster, repoRoot, roundFile, keypairPath, keypairCreated, agentName, faucetPath };
}
