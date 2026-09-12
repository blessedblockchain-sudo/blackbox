#!/usr/bin/env node
/**
 * Bakes `.mb/round-<cluster>.json` into `lib/generated/round.json`, which the
 * static build (NEXT_PUBLIC_STATIC=1) ships to the browser.
 *
 * The round file holds bot secret keys. Nothing is copied out of it except the
 * public fields listed in KEEP below: addresses, display names and timings.
 * The result is checked for secrets before it is written, and it is committed
 * so CI can build the static site without the (gitignored) .mb directory.
 *
 *   node scripts/bake-round.mjs [--cluster devnet] [--file path] [--check]
 *
 * `--check` verifies the committed file matches the round file instead of
 * writing (used by nothing automatic; handy before a release).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.join(here, "..");
const repoRoot = path.join(webRoot, "../..");
const OUT = path.join(webRoot, "lib/generated/round.json");

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const cluster = flag("cluster", "devnet");
const file = flag("file", path.join(repoRoot, ".mb", `round-${cluster}.json`));
const check = args.includes("--check");

const SECRET_KEY = /^(secretKey|secret|privateKey|private_key|keypair|mnemonic|seedPhrase)$/i;

/** Deep copy without any secret-bearing field, at any depth (mirrors lib/server/round-file.ts). */
function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY.test(k)) continue;
      out[k] = sanitize(v);
    }
    return out;
  }
  return value;
}

const str = (v) => (typeof v === "string" ? v : null);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function bake(raw) {
  const seen = new Set();
  const entrants = [];
  const add = (e, external) => {
    if (!e?.owner || seen.has(e.owner)) return;
    seen.add(e.owner);
    entrants.push({ name: String(e.name ?? ""), owner: e.owner, bot: !!e.bot, external });
  };
  (raw.entrants ?? []).forEach((e) => add(e, false));
  (raw.external ?? []).forEach((e) => add(e, true));
  return {
    cluster: raw.cluster === "local" ? "local" : "devnet",
    roundId: num(raw.roundId),
    round: str(raw.round),
    mint: str(raw.mint),
    feeds: Array.isArray(raw.feeds) ? raw.feeds.map(String) : [],
    markets: Array.isArray(raw.markets) && raw.markets.length ? raw.markets.map(String) : ["SOL-PERP", "BTC-PERP", "ETH-PERP"],
    tickMs: num(raw.tickMs),
    durationTicks: num(raw.durationTicks),
    mode: raw.mode === "dark" ? "dark" : raw.mode === "lit" ? "lit" : null,
    phase: str(raw.phase),
    registrationEndsAt: num(raw.registrationEndsAt),
    startedAt: num(raw.startedAt),
    updatedAt: num(raw.updatedAt),
    entrants,
    entrantOwners: Array.isArray(raw.entrantOwners) ? raw.entrantOwners.map(String) : [],
    backers: (raw.backers ?? []).filter((b) => b && typeof b.owner === "string").map((b) => ({ name: String(b.name ?? ""), owner: b.owner })),
    licenses: (raw.licenses ?? [])
      .filter((l) => l && typeof l.buyer === "string" && typeof l.author === "string")
      .map((l) => ({
        name: String(l.name ?? ""),
        buyer: l.buyer,
        author: l.author,
        bot: !!l.bot,
        scheduled: typeof l.scheduled === "boolean" ? l.scheduled : null,
        source: str(l.source),
      })),
    bakedAt: Date.now(),
  };
}

if (!fs.existsSync(file)) {
  console.error(`bake-round: ${file} not found. Run a round first, or pass --file.`);
  process.exit(1);
}
const raw = JSON.parse(fs.readFileSync(file, "utf8"));
const baked = bake(sanitize(raw));

// Belt and braces: refuse to write anything that still looks like a key.
const text = JSON.stringify(baked);
if (/secret|privateKey|mnemonic/i.test(text)) throw new Error("bake-round: refusing to write, output mentions a secret");
for (const v of Object.values(baked)) {
  if (Array.isArray(v) && v.some((x) => Array.isArray(x) && x.length === 64)) throw new Error("bake-round: refusing to write, output carries a 64-byte array");
}
if (!baked.round) throw new Error(`bake-round: ${file} has no round address`);

if (check) {
  const cur = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : null;
  const same = cur && cur.round === baked.round && JSON.stringify({ ...cur, bakedAt: 0 }) === JSON.stringify({ ...baked, bakedAt: 0 });
  console.log(same ? `bake-round: ${OUT} is up to date (round ${baked.round})` : `bake-round: ${OUT} is STALE`);
  process.exit(same ? 0 : 1);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(baked, null, 2)}\n`);
console.log(`bake-round: wrote ${path.relative(repoRoot, OUT)} — round ${baked.round} (#${baked.roundId}, ${baked.phase ?? "?"}), ${baked.entrants.length} entrants`);
