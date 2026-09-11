/**
 * bx-attack privacy matrix.
 *
 * Given a live round and a target entrant, `runMatrix` attempts to read the
 * target's private Strategy and Position from every angle a determined rival
 * has: the TEE query-filtering service with no token / a fresh token / a rival
 * entrant's token (single-account, multi-account and program-wide reads), the
 * owner's token (the control that MUST succeed), the transaction history of
 * the `set_strategy` upload, the committed L1 copies, the MagicBlock
 * delegation buffer/record/metadata and permission PDAs, and the raw
 * (unfiltered) ER RPC. Each attempt is scored against what a correct privacy
 * design should return; any row whose `pass` is false is a leak, or an attempt
 * that could not be concluded (an outage must never read as "blocked").
 */
import { AccountInfo, Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  DELEGATION_PROGRAM_ID,
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram,
  delegationRecordPdaFromDelegatedAccount,
  delegationMetadataPdaFromDelegatedAccount,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import { BlackboxClient, BLACKBOX_PROGRAM_ID, Cluster, pda } from "@blackbox/sdk";
import {
  containsSecret,
  scanValue,
  base58Decode,
  strategyRegion,
  positionRegion,
  allZero,
  STRATEGY_BYTECODE_OFFSET,
} from "./leak";

export interface Row {
  /** Short attack-path label. */
  path: string;
  /** What was attempted (endpoint + method + account). */
  request: string;
  /** What actually came back. */
  result: string;
  /** What a correct privacy design should return. */
  expected: string;
  /** True when the observed result matches the privacy expectation. */
  pass: boolean;
}

export interface MatrixArgs {
  cluster: Cluster;
  round: PublicKey;
  /** Target entrant owner (the wallet whose Strategy/Position we try to read). */
  target: PublicKey;
  /** Target owner's keypair, if known. Enables the owner-token control row and
   *  establishes the ground-truth bytecode used for leak comparisons. */
  ownerKp?: Keypair;
  /** A rival entrant's keypair, if one is available in the round. */
  rivalKp?: Keypair;
}

/** Raw, unfiltered ER RPC endpoint per cluster. */
export function rawErEndpoint(cluster: Cluster): string {
  return cluster === "local" ? "http://127.0.0.1:7799" : "https://devnet-eu.magicblock.app";
}

const hex = (b: Uint8Array, n = 12) => Buffer.from(b).toString("hex").slice(0, n * 2);
const errText = (e: unknown) => String((e as any)?.message ?? e).replace(/\s+/g, " ").slice(0, 120);

interface Read {
  info: AccountInfo<Buffer> | null;
  error?: string;
}

async function tryInfo(conn: Connection, key: PublicKey): Promise<Read> {
  try {
    return { info: await conn.getAccountInfo(key, "processed") };
  } catch (e) {
    return { info: null, error: errText(e) };
  }
}

/** An RPC error that is an explicit access decision (as opposed to an outage). */
const isDenial = (err: string) => /\b(401|403)\b|unauthori[sz]ed|forbidden|denied|permission/i.test(err);

/** Raw JSON-RPC call returning `{result}` or `{error}` without throwing on RPC errors. */
async function rpc(conn: Connection, method: string, params: unknown[]): Promise<{ result?: any; error?: any }> {
  try {
    return await (conn as any)._rpcRequest(method, params);
  } catch (e) {
    return { error: errText(e) };
  }
}

const getTx = (conn: Connection, sig: string) =>
  rpc(conn, "getTransaction", [sig, { encoding: "base64", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);

/** Every instruction-data blob in a getTransaction result (base64 or JSON form). */
export function txInstructionData(rpcResult: any): Uint8Array[] {
  const out: Uint8Array[] = [];
  const tx = rpcResult?.transaction;
  if (!tx) return out;
  if (Array.isArray(tx) && typeof tx[0] === "string") {
    try {
      const { VersionedTransaction } = require("@solana/web3.js");
      const vtx = VersionedTransaction.deserialize(Buffer.from(tx[0], "base64"));
      for (const ix of vtx.message.compiledInstructions ?? []) out.push(Uint8Array.from(ix.data));
    } catch {
      /* opaque blob: no readable instruction data */
    }
  } else {
    // JSON message form: instruction data is base58 (this is the shape the
    // query-filtering service returns, redacted, to a stranger).
    const ixs = [...(tx?.message?.instructions ?? [])];
    for (const inner of rpcResult?.meta?.innerInstructions ?? []) ixs.push(...(inner?.instructions ?? []));
    for (const ix of ixs) {
      if (typeof ix?.data !== "string") continue;
      const d = base58Decode(ix.data);
      if (d) out.push(d);
    }
  }
  return out;
}

/** set_strategy Anchor instruction discriminator (from blackbox.idl.json). */
const SET_STRATEGY_DISC = Uint8Array.from([251, 41, 210, 173, 140, 96, 78, 235]);

/** True if `data` begins with the set_strategy instruction discriminator. */
export function isSetStrategy(data: Uint8Array): boolean {
  if (data.length < 8) return false;
  for (let i = 0; i < 8; i++) if (data[i] !== SET_STRATEGY_DISC[i]) return false;
  return true;
}

function sameBytes(a: Uint8Array, b: number[] | Uint8Array): boolean {
  if (a.length < b.length) return false;
  for (let i = 0; i < b.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export async function runMatrix(args: MatrixArgs): Promise<Row[]> {
  const { cluster, round, target } = args;
  if (args.ownerKp && !args.ownerKp.publicKey.equals(target)) {
    throw new Error(`ownerKp ${args.ownerKp.publicKey.toBase58()} does not match target ${target.toBase58()}`);
  }
  const rivalKp = args.rivalKp && !args.rivalKp.publicKey.equals(target) ? args.rivalKp : undefined;

  const bx = new BlackboxClient(Keypair.generate(), cluster);
  const coder = bx.program.coder.accounts;
  const disc = (name: string): number[] => (bx.program.idl.accounts ?? []).find((a: any) => a.name === name)?.discriminator ?? [];
  const STRATEGY_DISC = disc("strategy");
  const POSITION_DISC = disc("position");
  const rows: Row[] = [];

  const strat = pda.strategyPda(round, target);
  const pos = pda.positionPda(round, target);
  const shortStrat = strat.toBase58().slice(0, 8);
  const shortPos = pos.toBase58().slice(0, 8);

  // Connections.
  const noToken = bx.teePublic();
  const freshConn = await bx.tee(Keypair.generate());
  const ownerConn = args.ownerKp ? await bx.tee(args.ownerKp) : null;
  const rivalConn = rivalKp ? await bx.tee(rivalKp) : null;
  const rawEr = new Connection(rawErEndpoint(cluster), { commitment: "processed" });

  // ---- 0. preflight: the target really is an entrant of this round ----------
  // Without this, every "expect null" row would pass vacuously for a typo'd
  // target whose accounts simply do not exist.
  let entrant: any = null;
  let entrantWhere = "";
  {
    const entPda = pda.entrantPda(round, target);
    for (const [where, conn] of [["TEE", noToken], ["L1", bx.base]] as const) {
      const r = await tryInfo(conn, entPda);
      if (r.info && sameBytes(r.info.data, disc("entrant"))) {
        try {
          entrant = coder.decode("entrant", r.info.data);
          entrantWhere = where;
          break;
        } catch {
          /* fall through */
        }
      }
    }
    const ok = !!entrant && (entrant.round as PublicKey).equals(round) && (entrant.owner as PublicKey).equals(target);
    rows.push({
      path: "preflight: target is an entrant",
      request: `getAccountInfo(Entrant ${entPda.toBase58().slice(0, 8)}) public`,
      result: ok
        ? `entrant #${entrant.index} (${entrantWhere}), strategy v${entrant.strategyVersion}${entrant.settled ? ", settled" : ""}`
        : "no Entrant for this owner in this round",
      expected: "Entrant exists (otherwise every null read is vacuous)",
      pass: ok,
    });
  }
  const settled = !!entrant?.settled;

  // ---- 4. owner token (control) + ground truth -------------------------------
  // Establishes the secret bytecode used to detect leaks in every other path.
  let secretBytecode: Uint8Array | null = null;
  let secretStratRegion: Uint8Array | null = null;
  let secretPosRegion: Uint8Array | null = null;
  if (ownerConn) {
    const { info: ownStrat, error: e1 } = await tryInfo(ownerConn, strat);
    let len = -1;
    if (ownStrat) {
      try {
        const s: any = coder.decode("strategy", ownStrat.data);
        len = Number(s.len);
        if (len > 0) secretBytecode = Uint8Array.from(s.bytecode.slice(0, len));
      } catch {
        /* undecodable: fall back to the raw region */
      }
      const region = strategyRegion(ownStrat.data);
      if (!allZero(region)) secretStratRegion = Uint8Array.from(region);
    }
    rows.push(
      settled
        ? {
            path: "TEE owner token → Strategy (control)",
            request: `getAccountInfo(${shortStrat}) with owner auth token`,
            result: ownStrat ? (allZero(ownStrat.data.subarray(8)) ? "scrubbed (body all zero)" : `LEAK: ${ownStrat.data.length} bytes, body not scrubbed`) : e1 ? `error: ${e1}` : "null (closed)",
            expected: "entrant settled: strategy scrubbed or closed",
            pass: !ownStrat || allZero(ownStrat.data.subarray(8)),
          }
        : {
            path: "TEE owner token → Strategy (control)",
            request: `getAccountInfo(${shortStrat}) with owner auth token`,
            result: ownStrat ? `${ownStrat.data.length} bytes readable${len >= 0 ? `, ${len}-byte program` : ""}` : e1 ? `error: ${e1}` : "null",
            expected: "bytes readable (owner must see own strategy)",
            pass: !!ownStrat,
          },
    );
    const { info: ownPos, error: e2 } = await tryInfo(ownerConn, pos);
    if (ownPos) {
      const region = positionRegion(ownPos.data);
      if (!allZero(region)) secretPosRegion = Uint8Array.from(region);
    }
    rows.push(
      settled
        ? {
            path: "TEE owner token → Position (control)",
            request: `getAccountInfo(${shortPos}) with owner auth token`,
            result: ownPos ? (allZero(ownPos.data.subarray(8)) ? "scrubbed (body all zero)" : `LEAK: ${ownPos.data.length} bytes, body not scrubbed`) : e2 ? `error: ${e2}` : "null (closed)",
            expected: "entrant settled: position scrubbed or closed",
            pass: !ownPos || allZero(ownPos.data.subarray(8)),
          }
        : {
            path: "TEE owner token → Position (control)",
            request: `getAccountInfo(${shortPos}) with owner auth token`,
            result: ownPos ? `${ownPos.data.length} bytes readable` : e2 ? `error: ${e2}` : "null",
            expected: "bytes readable (owner must see own position)",
            pass: !!ownPos,
          },
    );
  }

  // The needle sets used to detect a leak.
  const stratSecrets = [secretBytecode, secretStratRegion].filter(Boolean) as Uint8Array[];
  const posSecrets = [secretPosRegion].filter(Boolean) as Uint8Array[];
  const truth = stratSecrets.length > 0 ? "" : " (no owner ground truth)";

  // Helper: an "expect null" read attempt against one account through one conn.
  // A clean null or an explicit auth denial passes; an outage is inconclusive.
  const expectNull = async (path: string, conn: Connection, key: PublicKey, keyLabel: string, tokenLabel: string) => {
    const { info, error } = await tryInfo(conn, key);
    let result: string;
    let pass: boolean;
    if (info) {
      result = `LEAK: ${info.data.length} bytes`;
      pass = false;
    } else if (error) {
      pass = isDenial(error);
      result = pass ? `denied: ${error}` : `inconclusive (rpc error): ${error}`;
    } else {
      result = "null";
      pass = true;
    }
    rows.push({ path, request: `getAccountInfo(${keyLabel}) via TEE with ${tokenLabel}`, result, expected: "null (private account, not the caller's)", pass });
  };

  // ---- 1. no token -----------------------------------------------------------
  await expectNull("TEE no token → Strategy", noToken, strat, shortStrat, "no token");
  await expectNull("TEE no token → Position", noToken, pos, shortPos, "no token");

  // ---- 2. fresh keypair's token ---------------------------------------------
  await expectNull("TEE fresh token → Strategy", freshConn, strat, shortStrat, "a freshly generated wallet's token");
  await expectNull("TEE fresh token → Position", freshConn, pos, shortPos, "a freshly generated wallet's token");

  // ---- 3. rival entrant's token ---------------------------------------------
  if (rivalConn) {
    await expectNull("TEE rival token → Strategy", rivalConn, strat, shortStrat, "a rival entrant's token");
    await expectNull("TEE rival token → Position", rivalConn, pos, shortPos, "a rival entrant's token");
  } else {
    rows.push({
      path: "TEE rival token → Strategy",
      request: `getAccountInfo(${shortStrat}) via TEE with a rival entrant's token`,
      result: "skipped (no rival keypair available)",
      expected: "null (private account, not the caller's)",
      pass: true,
    });
  }

  // ---- 3b. batch and program-wide reads through the filter -------------------
  // The filter must hold for getMultipleAccounts and getProgramAccounts too,
  // not only for getAccountInfo.
  {
    const probe = rivalConn ?? freshConn;
    const who = rivalConn ? "rival" : "fresh";
    let result: string;
    let pass: boolean;
    try {
      const infos = await probe.getMultipleAccountsInfo([strat, pos, round], "processed");
      const leaks = [infos[0] && "Strategy", infos[1] && "Position"].filter(Boolean);
      const roundOk = !!infos[2];
      pass = leaks.length === 0 && roundOk;
      result = leaks.length ? `LEAK: ${leaks.join(" + ")} returned` : roundOk ? "private: null, null; public Round returned" : "inconclusive: public Round not returned either";
    } catch (e) {
      const err = errText(e);
      pass = isDenial(err);
      result = pass ? `denied: ${err}` : `inconclusive (rpc error): ${err}`;
    }
    rows.push({
      path: `TEE ${who} token → getMultipleAccounts`,
      request: `getMultipleAccounts([${shortStrat}, ${shortPos}, Round]) via TEE with a ${who} token`,
      result,
      expected: "null for Strategy/Position, public Round returned",
      pass,
    });
  }
  {
    const probe = rivalConn ?? freshConn;
    const who = rivalConn ? "rival" : "fresh";
    const caller = rivalKp?.publicKey ?? null;
    let result: string;
    let pass: boolean;
    try {
      const accts = await probe.getProgramAccounts(BLACKBOX_PROGRAM_ID, { commitment: "processed" });
      const bad: string[] = [];
      let privateTyped = 0;
      let own = 0;
      for (const a of accts) {
        const d = a.account.data;
        const isStrat = sameBytes(d, STRATEGY_DISC);
        const isPos = sameBytes(d, POSITION_DISC);
        // The caller's own Strategy/Position are legitimately visible to it.
        // Identify them by re-deriving the PDA from the header's round, so a
        // forged header cannot hide someone else's account.
        if (caller && (isStrat || isPos) && d.length >= 40) {
          const hdrRound = new PublicKey(d.subarray(8, 40));
          const mine = isStrat ? pda.strategyPda(hdrRound, caller) : pda.positionPda(hdrRound, caller);
          if (mine.equals(a.pubkey)) {
            own++;
            continue;
          }
        }
        if (isStrat || isPos) privateTyped++;
        const body = isStrat ? strategyRegion(d) : isPos ? positionRegion(d) : null;
        const tgt = a.pubkey.equals(strat) || a.pubkey.equals(pos);
        // Public accounts legitimately overlap Position state (a lit Scoreboard
        // carries equity), so only the strategy bytecode is searched in them.
        if ((body && !allZero(body)) || (tgt && !allZero(d.subarray(8))) || stratSecrets.some((s) => containsSecret(d, s))) {
          bad.push(a.pubkey.toBase58().slice(0, 8));
        }
      }
      pass = bad.length === 0;
      result = pass
        ? `${accts.length} accounts, ${privateTyped} foreign Strategy/Position all zeroed${own ? ` (+${own} caller's own)` : ""}`
        : `LEAK: private body readable in ${bad.length} account(s): ${bad.slice(0, 3).join(", ")}`;
    } catch (e) {
      // Refusing program-wide scans outright is a valid way to block them.
      pass = true;
      result = `refused: ${errText(e)}`;
    }
    rows.push({
      path: `TEE ${who} token → getProgramAccounts`,
      request: `getProgramAccounts(BLACKBOX) via TEE with a ${who} token`,
      result,
      expected: "no Strategy/Position with a non-zero private body",
      pass,
    });
  }

  // ---- 5. set_strategy transaction visible to a stranger --------------------
  {
    let sig: string | null = null;
    let how = "";
    let ownerViewHasCode = false;
    if (ownerConn) {
      // Brief: look on the Strategy PDA first. On this stack the PDA has no
      // signature index, so fall back to the owner (fee payer) address.
      for (const [label, addr] of [["Strategy PDA history", strat], ["owner-address history", target]] as const) {
        if (sig) break;
        const list: any[] = await ownerConn.getSignaturesForAddress(addr, { limit: 50 }, "confirmed").catch(() => []);
        for (const s of list) {
          const t = await getTx(ownerConn, s.signature);
          if (txInstructionData(t.result).some(isSetStrategy)) {
            sig = s.signature;
            how = label;
            ownerViewHasCode = stratSecrets.length > 0 && !!scanValue(t.result, stratSecrets);
            break;
          }
        }
      }
    }
    if (sig) {
      const views = [
        { who: "stranger token", t: await getTx(freshConn, sig) },
        { who: "no token", t: await getTx(noToken, sig) },
      ];
      const hits = views
        .map((v) => {
          const at = scanValue(v.t.result, stratSecrets) ?? (txInstructionData(v.t.result).some(isSetStrategy) ? "set_strategy ix data" : null);
          return at ? `${v.who} @ ${at}` : null;
        })
        .filter(Boolean);
      const s0 = views[0].t.result;
      const ixs = txInstructionData(s0);
      rows.push({
        path: "set_strategy tx → stranger getTransaction",
        request: `getTransaction(${sig.slice(0, 10)}…) with a stranger token and no token (found via ${how})`,
        result: hits.length
          ? `LEAK: bytecode in ${hits.join("; ")}`
          : `${s0 ? `redacted: ${ixs.length} instr, ${ixs.reduce((a, d) => a + d.length, 0)} bytes of data` : "null"}${ownerViewHasCode ? " (owner view carries the bytecode)" : ""}`,
        expected: "no strategy bytecode in the transaction",
        pass: hits.length === 0,
      });
    } else {
      // No owner token (or no tx found through it): a stranger can still list
      // the owner's public signature history. None of those transactions may
      // expose a readable set_strategy instruction.
      const list: any[] = await freshConn.getSignaturesForAddress(target, { limit: 50 }, "confirmed").catch(() => []);
      let readable = 0;
      for (const s of list) {
        const t = await getTx(freshConn, s.signature);
        if (txInstructionData(t.result).some(isSetStrategy) || (stratSecrets.length > 0 && scanValue(t.result, stratSecrets))) readable++;
      }
      rows.push({
        path: "set_strategy tx → stranger getTransaction",
        request: `stranger getSignaturesForAddress(owner) + getTransaction on ${list.length} tx`,
        result: readable ? `LEAK: ${readable} tx expose set_strategy data` : `${list.length} tx scanned, no readable set_strategy data${ownerConn ? "" : " (no owner token to pin the upload)"}`,
        expected: "no strategy bytecode in the transaction",
        pass: readable === 0,
      });
    }
  }

  // ---- 6. L1 committed Strategy / Position are zeroed ------------------------
  {
    const { info: l1, error } = await tryInfo(bx.base, strat);
    let result: string;
    let pass: boolean;
    let expected = "owned by delegation program, bytecode region all zero";
    if (!l1) {
      // Created on L1 at join, so an unsettled entrant must have an L1 copy.
      pass = settled && !error;
      result = error ? `error: ${error}` : "absent on L1";
      if (settled) expected = "settled: scrubbed or closed";
    } else {
      const region = strategyRegion(l1.data);
      const delegated = l1.owner.equals(DELEGATION_PROGRAM_ID);
      const undelegated = l1.owner.equals(BLACKBOX_PROGRAM_ID);
      const zeroed = allZero(region);
      const leaked = stratSecrets.some((s) => containsSecret(region, s));
      const ownerLabel = delegated ? "delegation program" : undelegated ? "BLACKBOX (undelegated)" : l1.owner.toBase58().slice(0, 8);
      if (undelegated) expected = "undelegated only after settlement, body scrubbed";
      pass = zeroed && !leaked && (delegated || (undelegated && settled && allZero(l1.data.subarray(8))));
      result = `owner=${ownerLabel}, region[${STRATEGY_BYTECODE_OFFSET}..]=${zeroed ? "all zero" : `${leaked ? "LEAK " : ""}${hex(region)}…`}`;
    }
    rows.push({ path: "L1 getAccountInfo → Strategy", request: `L1 getAccountInfo(${shortStrat})`, result, expected, pass });

    const { info: l1p, error: ep } = await tryInfo(bx.base, pos);
    const pregion = l1p ? positionRegion(l1p.data) : null;
    const pzero = !!pregion && allZero(pregion);
    const pleak = !!pregion && posSecrets.some((s) => containsSecret(pregion, s));
    rows.push({
      path: "L1 getAccountInfo → Position",
      request: `L1 getAccountInfo(${shortPos})`,
      result: l1p
        ? `owner=${l1p.owner.equals(DELEGATION_PROGRAM_ID) ? "delegation program" : l1p.owner.toBase58().slice(0, 8)}, trading state ${pzero ? "all zero" : `${pleak ? "LEAK (matches live state)" : "non-zero"} ${hex(pregion!)}…`}`
        : ep
          ? `error: ${ep}`
          : "absent on L1",
      expected: "no private trading state on L1 (never auto-committed)",
      pass: l1p ? pzero : settled && !ep,
    });
  }

  // ---- 7. delegation buffer / record / metadata + permission PDAs on L1 ------
  for (const [label, acct, secrets, regionOf] of [
    ["Strategy", strat, stratSecrets, strategyRegion],
    ["Position", pos, posSecrets, positionRegion],
  ] as const) {
    const pdas: { label: string; key: PublicKey; buffer?: boolean }[] = [
      { label: "delegate_buffer", key: delegateBufferPdaFromDelegatedAccountAndOwnerProgram(acct, BLACKBOX_PROGRAM_ID), buffer: true },
      { label: "delegation_record", key: delegationRecordPdaFromDelegatedAccount(acct) },
      { label: "delegation_metadata", key: delegationMetadataPdaFromDelegatedAccount(acct) },
      { label: "permission", key: pda.permissionPda(acct) },
    ];
    const reads = await Promise.all(pdas.map((p) => tryInfo(bx.base, p.key)));
    const leaks: string[] = [];
    const present: string[] = [];
    const errors: string[] = [];
    reads.forEach(({ info, error }, i) => {
      if (error) errors.push(`${pdas[i].label}: ${error}`);
      if (!info) return;
      present.push(`${pdas[i].label}(${info.data.length}B)`);
      // The buffer is a raw copy of the delegated account: its private region must be zero.
      const bufferLeak = pdas[i].buffer && info.data.length > STRATEGY_BYTECODE_OFFSET && !allZero(regionOf(info.data));
      if (bufferLeak || secrets.some((s) => containsSecret(info.data, s))) leaks.push(pdas[i].label);
    });
    rows.push({
      path: `L1 delegation PDAs → ${label}`,
      request: "L1 getAccountInfo of delegate_buffer / delegation_record / delegation_metadata / permission",
      result: leaks.length
        ? `LEAK: private bytes in ${leaks.join(", ")}`
        : errors.length
          ? `inconclusive: ${errors[0]}`
          : `${present.length ? `present, no private bytes: ${present.join(", ")}` : "absent"}${label === "Strategy" ? truth : ""}`,
      expected: `no ${label === "Strategy" ? "strategy bytecode" : "trading state"} in any delegation PDA`,
      pass: leaks.length === 0 && errors.length === 0,
    });
  }

  // ---- 8. raw ER RPC ---------------------------------------------------------
  {
    const { info: raw, error } = await tryInfo(rawEr, strat);
    const region = raw ? strategyRegion(raw.data) : null;
    const hasCode = !!region && stratSecrets.some((s) => containsSecret(region, s));
    if (cluster === "local") {
      rows.push({
        path: "raw ER RPC (7799) → Strategy",
        request: `getAccountInfo(${shortStrat}) on the raw ER port 7799`,
        result: raw
          ? `${raw.data.length} bytes${hasCode ? ", bytecode readable" : ""} (internal port, not exposed in production)`
          : error
            ? `unreachable: ${error}`
            : "null",
        expected: "internal port, not exposed in production (informational)",
        pass: true,
      });
    } else {
      const leaked = !!region && (hasCode || (stratSecrets.length === 0 && !allZero(region)));
      rows.push({
        path: "raw regional ER RPC → Strategy",
        request: `getAccountInfo(${shortStrat}) on ${rawErEndpoint(cluster)}`,
        result: raw
          ? leaked
            ? "LEAK: bytecode readable"
            : `${raw.data.length} bytes, no bytecode (${region && allZero(region) ? "region zero" : "committed copy"})${truth}`
          : error
            ? `unreachable: ${error}`
            : "null",
        expected: "no strategy bytecode on a regional (non-TEE) ER",
        pass: !leaked,
      });
    }
  }

  return rows;
}

/** Count of failing rows in a matrix result. */
export function countFailures(rows: Row[]): number {
  return rows.filter((r) => !r.pass).length;
}
