#!/usr/bin/env ts-node
/**
 * bx-attack — prove BLACKBOX strategy/position privacy by trying to break it.
 *
 *   bx-attack --cluster local|devnet [--round-file <path>] [--target <owner>|--index N]
 *
 * Loads the round state file, picks a target entrant (bot secret keys in the
 * file provide the owner-token control row and a rival-token row), runs the
 * privacy matrix against the live TEE, prints an aligned table, and exits
 * non-zero if any attack path succeeded (i.e. any private byte leaked).
 */
import { PublicKey } from "@solana/web3.js";
import { Cluster } from "@blackbox/sdk";
import { runMatrix, countFailures, Row } from "./matrix";
import { defaultRoundFile, loadRoundFile, selectTarget } from "./roundfile";
import { renderTable } from "./table";

interface Args {
  cluster: Cluster;
  roundFile?: string;
  target?: string;
  index?: number;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { cluster: "local" };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${k} needs a value`);
      return v;
    };
    switch (k) {
      case "--cluster": a.cluster = next() as Cluster; break;
      case "--round-file": a.roundFile = next(); break;
      case "--target": a.target = next(); break;
      case "--index": {
        const v = next();
        if (!/^\d+$/.test(v)) throw new Error(`--index must be a non-negative integer (got ${v})`);
        a.index = Number(v);
        break;
      }
      case "-h": case "--help":
        console.log("usage: bx-attack --cluster local|devnet [--round-file <path>] [--target <owner>|--index N]");
        process.exit(0);
      default:
        throw new Error(`unknown argument: ${k}`);
    }
  }
  if (a.cluster !== "local" && a.cluster !== "devnet") throw new Error(`--cluster must be local or devnet (got ${a.cluster})`);
  if (a.target !== undefined && a.index !== undefined) throw new Error("use either --target or --index, not both");
  if (a.target !== undefined) {
    try {
      new PublicKey(a.target);
    } catch {
      throw new Error(`--target is not a base58 public key: ${a.target}`);
    }
  }
  return a;
}

function shorten(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const file = args.roundFile ?? defaultRoundFile(args.cluster);
  const rf = loadRoundFile(file);
  if (rf.cluster && rf.cluster !== args.cluster) throw new Error(`round file ${file} is for cluster ${rf.cluster}, not ${args.cluster}`);
  const sel = selectTarget(rf, { target: args.target, index: args.index });

  console.log(`bx-attack — privacy matrix`);
  console.log(`  cluster : ${args.cluster}`);
  console.log(`  round   : ${rf.round} (#${rf.roundId}, ${rf.mode}, phase ${rf.phase})`);
  console.log(`  target  : ${sel.targetName} ${sel.target.toBase58()}`);
  console.log(`  owner   : ${sel.ownerKp ? "token available (control row enabled)" : "unknown (no control row)"}`);
  console.log(`  rival   : ${sel.rivalKp ? `${sel.rivalName} token available` : "none available"}`);
  console.log("");

  const rows: Row[] = await runMatrix({
    cluster: args.cluster,
    round: new PublicKey(rf.round),
    target: sel.target,
    ownerKp: sel.ownerKp,
    rivalKp: sel.rivalKp,
  });

  const table = renderTable(
    ["PATH", "RESULT", "EXPECTED", "STATUS"],
    rows.map((r) => [shorten(r.path, 40), shorten(r.result, 60), shorten(r.expected, 44), r.pass ? "PASS" : "FAIL"]),
  );
  console.log(table);

  const fails = countFailures(rows);
  console.log("");
  console.log(`${rows.length - fails}/${rows.length} rows pass; ${fails} failing (leak or inconclusive).`);
  if (fails > 0) {
    console.log("FAILING ROWS:");
    for (const r of rows.filter((x) => !x.pass)) console.log(`  - ${r.path}: ${r.result}`);
  }
  process.exit(fails > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(`bx-attack error: ${e?.message ?? e}`);
  process.exit(2);
});
