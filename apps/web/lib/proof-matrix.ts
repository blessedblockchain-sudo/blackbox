/**
 * The bx-attack privacy matrix, run from the browser.
 *
 * `apps/attacker/src/matrix.ts` is the reference implementation; it runs under
 * ts-node with a round file full of keypairs and builds a BlackboxClient. None
 * of that exists in a browser, so this module reproduces the same attack paths
 * with nothing but `fetch`, web3.js and an ephemeral keypair:
 *
 *   - "no token"    — the TEE's public endpoint.
 *   - "fresh token" — a keypair generated in this tab, signed into the TEE.
 *   - "rival token" — the visitor's connected wallet when one is signed in
 *                     (labelled as an entrant only when it really is one);
 *                     otherwise a second ephemeral keypair, labelled as such.
 *   - "owner (control)" — only when the connected wallet *is* the target; the
 *                     rows are marked skipped otherwise instead of pretending.
 *   - L1, delegation PDAs, the regional (non-TEE) ER and the set_strategy
 *     transaction: plain public reads, identical to the CLI's.
 *
 * The byte-level leak detectors are imported from `apps/attacker/src/leak.ts`,
 * which is pure and browser-safe (it needs only the Buffer polyfill).
 */
import { Buffer } from "./polyfills";
import { Connection, Keypair, PublicKey, type AccountInfo } from "@solana/web3.js";
import nacl from "tweetnacl";
import { allZero, containsSecret, positionRegion, scanValue, strategyRegion, base58Decode, STRATEGY_BYTECODE_OFFSET } from "@blackbox/attacker/src/leak";
import { IDL, PROGRAM_ID, decodeAccount, entrantPda, positionPda, strategyPda } from "./chain";
import { DELEGATION_PROGRAM_ID, delegateBufferPda, delegationMetadataPda, delegationRecordPda, permissionPda } from "./espl";
import { getAuthToken, tokenUrl } from "./tee-auth";
import { accessOf } from "./proof";
import { shortAddr } from "./format";
import type { Cluster, ProofResponse, ProofRow } from "./api-types";

// ------------------------------------------------------------------ plumbing

/** Raw, unfiltered ER RPC endpoint per cluster (mirrors attacker/src/matrix.ts). */
export function rawErEndpoint(cluster: Cluster): string {
  return cluster === "local" ? "http://127.0.0.1:7799" : "https://devnet-eu.magicblock.app";
}

const disc = (name: string): number[] => (IDL.accounts ?? []).find((a) => a.name === name)?.discriminator ?? [];
const hex = (b: Uint8Array, n = 12) => Array.from(b.subarray(0, n), (x) => x.toString(16).padStart(2, "0")).join("");
const errText = (e: unknown) => String((e as { message?: string })?.message ?? e).replace(/\s+/g, " ").slice(0, 120);
/** An RPC error that is an explicit access decision (as opposed to an outage). */
const isDenial = (err: string) => /\b(401|403)\b|unauthori[sz]ed|forbidden|denied|permission/i.test(err);

function sameBytes(a: Uint8Array, b: number[] | Uint8Array): boolean {
  if (a.length < b.length) return false;
  for (let i = 0; i < b.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

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

/* eslint-disable @typescript-eslint/no-explicit-any */
/** One JSON-RPC call by fetch, so token-bearing URLs and raw results stay simple. */
async function rpc(url: string, method: string, params: unknown[]): Promise<{ result?: any; error?: any }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return (await res.json()) as { result?: any; error?: any };
  } catch (e) {
    return { error: errText(e) };
  }
}

const getTx = (url: string, sig: string) => rpc(url, "getTransaction", [sig, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);

/** Every instruction-data blob in a getTransaction result (JSON message form). */
export function txInstructionData(rpcResult: any): Uint8Array[] {
  const out: Uint8Array[] = [];
  const tx = rpcResult?.transaction;
  if (!tx) return out;
  const ixs = [...(tx?.message?.instructions ?? [])];
  for (const inner of rpcResult?.meta?.innerInstructions ?? []) ixs.push(...(inner?.instructions ?? []));
  for (const ix of ixs) {
    if (typeof ix?.data !== "string") continue;
    const d = base58Decode(ix.data);
    if (d) out.push(d);
  }
  return out;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** set_strategy Anchor instruction discriminator (from blackbox.idl.json). */
const SET_STRATEGY_DISC = Uint8Array.from([251, 41, 210, 173, 140, 96, 78, 235]);
export function isSetStrategy(data: Uint8Array): boolean {
  return data.length >= 8 && sameBytes(data, SET_STRATEGY_DISC);
}

/** A throwaway wallet with a TEE auth token, created in this tab and never stored. */
export async function ephemeralToken(tee: string): Promise<{ pubkey: string; token: string }> {
  const kp = Keypair.generate();
  const { token } = await getAuthToken(tee, kp.publicKey.toBase58(), async (m) => nacl.sign.detached(m, kp.secretKey));
  return { pubkey: kp.publicKey.toBase58(), token };
}

// ------------------------------------------------------------------ the matrix

export interface WalletIdentity {
  owner: string;
  /** TEE auth token for `owner` (the wallet signed the login challenge). */
  token: string;
  /** True when this wallet has an Entrant account in this round. */
  isEntrant: boolean;
  name: string;
}

export interface BrowserProofArgs {
  cluster: Cluster;
  base: string;
  tee: string;
  round: PublicKey;
  target: PublicKey;
  targetName: string;
  /** The visitor's signed-in wallet, when there is one. */
  wallet?: WalletIdentity | null;
  /** Called after each row so the page can stream results. */
  onRow?: (row: ProofRow, total: number) => void;
}

const TOTAL_ROWS = 17;

export async function runBrowserProof(args: BrowserProofArgs): Promise<ProofResponse> {
  const { cluster, base, tee, round, target, targetName } = args;
  const t0 = Date.now();
  const rows: ProofRow[] = [];
  const push = (r: Omit<ProofRow, "access">) => {
    const row: ProofRow = { ...r, access: accessOf(r) };
    rows.push(row);
    args.onRow?.(row, TOTAL_ROWS);
  };

  const STRATEGY_DISC = disc("Strategy");
  const POSITION_DISC = disc("Position");
  const ENTRANT_DISC = disc("Entrant");

  const strat = strategyPda(round, target);
  const pos = positionPda(round, target);
  const shortStrat = strat.toBase58().slice(0, 8);
  const shortPos = pos.toBase58().slice(0, 8);

  const wallet = args.wallet ?? null;
  const walletIsTarget = !!wallet && wallet.owner === target.toBase58();

  // Identities. The fresh keypair is always available; the "rival" is the
  // connected wallet when it is not the target, else a second fresh keypair.
  const fresh = await ephemeralToken(tee);
  const rival: { url: string; owner: string | null; label: string; who: string; path: string; entrant: boolean } = walletIsTarget || !wallet
    ? await (async () => {
        const second = await ephemeralToken(tee);
        return {
          url: tokenUrl(tee, second.token),
          owner: second.pubkey,
          label: "a second freshly generated wallet's token",
          who: "a second wallet, not an entrant of this round (no rival entrant key exists in a browser)",
          path: "second wallet token",
          entrant: false,
        };
      })()
    : {
        url: tokenUrl(tee, wallet.token),
        owner: wallet.owner,
        label: wallet.isEntrant ? "a rival entrant's token" : "another connected wallet's token",
        who: wallet.isEntrant ? `a rival entrant (${wallet.name}), with its token` : `another wallet (${shortAddr(wallet.owner)}), not an entrant of this round`,
        path: wallet.isEntrant ? "rival token" : "another wallet token",
        entrant: !!wallet.isEntrant,
      };

  const noTokenUrl = tee;
  const freshUrl = tokenUrl(tee, fresh.token);
  const ownerUrl = walletIsTarget && wallet ? tokenUrl(tee, wallet.token) : null;

  const noToken = new Connection(noTokenUrl, { commitment: "processed" });
  const freshConn = new Connection(freshUrl, { commitment: "processed" });
  const rivalConn = new Connection(rival.url, { commitment: "processed" });
  const ownerConn = ownerUrl ? new Connection(ownerUrl, { commitment: "processed" }) : null;
  const l1 = new Connection(base, { commitment: "confirmed" });
  const rawEr = new Connection(rawErEndpoint(cluster), { commitment: "processed" });

  // ---- 0. preflight: the target really is an entrant of this round ----------
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let entrant: any = null;
  let entrantWhere = "";
  {
    const entKey = entrantPda(round, target);
    for (const [where, conn] of [["TEE", noToken], ["L1", l1]] as const) {
      const r = await tryInfo(conn, entKey);
      if (r.info && sameBytes(r.info.data, ENTRANT_DISC)) {
        try {
          entrant = decodeAccount("entrant", r.info.data);
          entrantWhere = where;
          break;
        } catch {
          /* fall through to the next source */
        }
      }
    }
    const ok = !!entrant && (entrant.round as PublicKey).equals(round) && (entrant.owner as PublicKey).equals(target);
    push({
      path: "preflight: target is an entrant",
      who: "anyone (public Entrant)",
      request: `getAccountInfo(Entrant ${entKey.toBase58().slice(0, 8)}) public`,
      result: ok
        ? `entrant #${entrant.index} (${entrantWhere}), strategy v${entrant.strategyVersion}${entrant.settled ? ", settled" : ""}`
        : "no Entrant for this owner in this round",
      expected: "Entrant exists (otherwise every null read is vacuous)",
      pass: ok,
    });
  }
  const settled = !!entrant?.settled;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  // ---- 1. owner token (control) + ground truth -------------------------------
  let secretBytecode: Uint8Array | null = null;
  let secretStratRegion: Uint8Array | null = null;
  let secretPosRegion: Uint8Array | null = null;
  if (ownerConn) {
    const who = `the owner (${targetName}), with its auth token`;
    const { info: ownStrat, error: e1 } = await tryInfo(ownerConn, strat);
    let len = -1;
    if (ownStrat) {
      try {
        /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
        const s: any = decodeAccount("strategy", ownStrat.data);
        len = Number(s.len);
        if (len > 0) secretBytecode = Uint8Array.from(s.bytecode.slice(0, len));
      } catch {
        /* undecodable: fall back to the raw region */
      }
      const region = strategyRegion(ownStrat.data);
      if (!allZero(region)) secretStratRegion = Uint8Array.from(region);
    }
    push(
      settled
        ? {
            path: "TEE owner token → Strategy (control)",
            who,
            request: `getAccountInfo(${shortStrat}) with the owner's auth token`,
            result: ownStrat ? (allZero(ownStrat.data.subarray(8)) ? "scrubbed (body all zero)" : `LEAK: ${ownStrat.data.length} bytes, body not scrubbed`) : e1 ? `error: ${e1}` : "null (closed)",
            expected: "entrant settled: strategy scrubbed or closed",
            pass: !ownStrat || allZero(ownStrat.data.subarray(8)),
          }
        : {
            path: "TEE owner token → Strategy (control)",
            who,
            request: `getAccountInfo(${shortStrat}) with the owner's auth token`,
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
    push(
      settled
        ? {
            path: "TEE owner token → Position (control)",
            who,
            request: `getAccountInfo(${shortPos}) with the owner's auth token`,
            result: ownPos ? (allZero(ownPos.data.subarray(8)) ? "scrubbed (body all zero)" : `LEAK: ${ownPos.data.length} bytes, body not scrubbed`) : e2 ? `error: ${e2}` : "null (closed)",
            expected: "entrant settled: position scrubbed or closed",
            pass: !ownPos || allZero(ownPos.data.subarray(8)),
          }
        : {
            path: "TEE owner token → Position (control)",
            who,
            request: `getAccountInfo(${shortPos}) with the owner's auth token`,
            result: ownPos ? `${ownPos.data.length} bytes readable` : e2 ? `error: ${e2}` : "null",
            expected: "bytes readable (owner must see own position)",
            pass: !!ownPos,
          },
    );
  } else {
    push({
      path: "TEE owner token → Strategy (control)",
      who: `the owner (${targetName}), with its auth token`,
      request: `getAccountInfo(${shortStrat}) with the owner's auth token`,
      result: wallet ? `skipped: the connected wallet is ${shortAddr(wallet.owner)}, not this entrant` : "skipped: no key for this entrant in the browser — connect this entrant's wallet to run the control",
      expected: "bytes readable (owner must see own strategy)",
      pass: true,
    });
  }

  // The needle sets used to detect a leak.
  const stratSecrets = [secretBytecode, secretStratRegion].filter(Boolean) as Uint8Array[];
  const posSecrets = [secretPosRegion].filter(Boolean) as Uint8Array[];
  const truth = stratSecrets.length > 0 ? "" : " (no owner ground truth)";

  /**
   * A read that must give a stranger nothing.
   *
   * While the entrant is live that means a null: the permission names only the
   * owner. Once `settle_entrant` has run, the private bodies are zeroed and the
   * permissions are closed, so the account is public again and reads as 4 KB of
   * zeros — which is the design working, not a leak. Anything non-zero is.
   */
  const expectSealed = async (path: string, who: string, conn: Connection, key: PublicKey, keyLabel: string, tokenLabel: string) => {
    const { info, error } = await tryInfo(conn, key);
    const expected = settled ? "entrant settled: closed, or public and all zero" : "null (private account, not the caller's)";
    let result: string;
    let pass: boolean;
    if (info) {
      const zero = allZero(info.data.subarray(8));
      pass = settled && zero;
      result = pass ? `${info.data.length} bytes, body all zero (scrubbed at settlement)` : `LEAK: ${info.data.length} bytes${settled ? ", body not scrubbed" : ""}`;
    } else if (error) {
      pass = isDenial(error);
      result = pass ? `denied: ${error}` : `inconclusive (rpc error): ${error}`;
    } else {
      result = settled ? "null (closed)" : "null";
      pass = true;
    }
    push({ path, who, request: `getAccountInfo(${keyLabel}) via TEE with ${tokenLabel}`, result, expected, pass });
  };

  // ---- 2. no token ----------------------------------------------------------
  await expectSealed("TEE no token → Strategy", "anyone, no auth token", noToken, strat, shortStrat, "no token");
  await expectSealed("TEE no token → Position", "anyone, no auth token", noToken, pos, shortPos, "no token");

  // ---- 3. a freshly generated wallet's token --------------------------------
  const freshWho = `a brand-new wallet (${shortAddr(fresh.pubkey)}) generated in this tab, with its token`;
  await expectSealed("TEE fresh token → Strategy", freshWho, freshConn, strat, shortStrat, "a freshly generated wallet's token");
  await expectSealed("TEE fresh token → Position", freshWho, freshConn, pos, shortPos, "a freshly generated wallet's token");

  // ---- 4. the rival / second wallet's token ---------------------------------
  await expectSealed(`TEE ${rival.path} → Strategy`, rival.who, rivalConn, strat, shortStrat, rival.label);
  await expectSealed(`TEE ${rival.path} → Position`, rival.who, rivalConn, pos, shortPos, rival.label);

  // ---- 5. batch and program-wide reads through the filter --------------------
  {
    let result: string;
    let pass: boolean;
    try {
      const infos = await rivalConn.getMultipleAccountsInfo([strat, pos, round], "processed");
      // Settled accounts come back public and zeroed; only a non-zero body leaks.
      const leaked = (acc: (typeof infos)[number]) => !!acc && !(settled && allZero(acc.data.subarray(8)));
      const leaks = [leaked(infos[0]) && "Strategy", leaked(infos[1]) && "Position"].filter(Boolean);
      const roundOk = !!infos[2];
      pass = leaks.length === 0 && roundOk;
      result = leaks.length
        ? `LEAK: ${leaks.join(" + ")} returned`
        : roundOk
          ? settled
            ? "private accounts scrubbed (all zero); public Round returned"
            : "private: null, null; public Round returned"
          : "inconclusive: public Round not returned either";
    } catch (e) {
      const err = errText(e);
      pass = isDenial(err);
      result = pass ? `denied: ${err}` : `inconclusive (rpc error): ${err}`;
    }
    push({
      path: `TEE ${rival.path} → getMultipleAccounts`,
      who: rival.who,
      request: `getMultipleAccounts([${shortStrat}, ${shortPos}, Round]) via TEE with ${rival.label}`,
      result,
      expected: settled ? "nothing but zeros for Strategy/Position, public Round returned" : "null for Strategy/Position, public Round returned",
      pass,
    });
  }
  {
    const caller = rival.owner ? new PublicKey(rival.owner) : null;
    let result: string;
    let pass: boolean;
    try {
      const accts = await rivalConn.getProgramAccounts(PROGRAM_ID, { commitment: "processed" });
      const bad: string[] = [];
      let privateTyped = 0;
      let own = 0;
      for (const a of accts) {
        const d = a.account.data;
        const isStrat = sameBytes(d, STRATEGY_DISC);
        const isPos = sameBytes(d, POSITION_DISC);
        // The caller's own Strategy/Position are legitimately visible to it.
        if (caller && (isStrat || isPos) && d.length >= 40) {
          const hdrRound = new PublicKey(d.subarray(8, 40));
          const mine = isStrat ? strategyPda(hdrRound, caller) : positionPda(hdrRound, caller);
          if (mine.equals(a.pubkey)) {
            own++;
            continue;
          }
        }
        if (isStrat || isPos) privateTyped++;
        const body = isStrat ? strategyRegion(d) : isPos ? positionRegion(d) : null;
        const tgt = a.pubkey.equals(strat) || a.pubkey.equals(pos);
        if ((body && !allZero(body)) || (tgt && !allZero(d.subarray(8))) || stratSecrets.some((s) => containsSecret(d, s))) bad.push(a.pubkey.toBase58().slice(0, 8));
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
    push({
      path: `TEE ${rival.path} → getProgramAccounts`,
      who: rival.who,
      request: `getProgramAccounts(BLACKBOX) via TEE with ${rival.label}`,
      result,
      expected: "no Strategy/Position with a non-zero private body",
      pass,
    });
  }

  // ---- 6. set_strategy transaction visible to a stranger --------------------
  {
    const SCAN_LIMIT = 15;
    let sig: string | null = null;
    let how = "";
    let ownerViewHasCode = false;
    if (ownerUrl) {
      for (const [label, addr] of [["Strategy PDA history", strat], ["owner-address history", target]] as const) {
        if (sig) break;
        /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
        const list: any[] = (await rpc(ownerUrl, "getSignaturesForAddress", [addr.toBase58(), { limit: SCAN_LIMIT }])).result ?? [];
        for (const s of list) {
          const t = await getTx(ownerUrl, s.signature);
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
        { who: "stranger token", t: await getTx(freshUrl, sig) },
        { who: "no token", t: await getTx(noTokenUrl, sig) },
      ];
      const hits = views
        .map((v) => {
          const at = scanValue(v.t.result, stratSecrets) ?? (txInstructionData(v.t.result).some(isSetStrategy) ? "set_strategy ix data" : null);
          return at ? `${v.who} @ ${at}` : null;
        })
        .filter(Boolean);
      const s0 = views[0].t.result;
      const ixs = txInstructionData(s0);
      push({
        path: "set_strategy tx → stranger getTransaction",
        who: "a stranger's token and no token",
        request: `getTransaction(${sig.slice(0, 10)}…) with a stranger token and no token (found via ${how})`,
        result: hits.length
          ? `LEAK: bytecode in ${hits.join("; ")}${settled ? " — settle_entrant closed the permission, and with it the TX_MESSAGE filter that redacted this upload while the round ran" : ""}`
          : `${s0 ? `redacted: ${ixs.length} instr, ${ixs.reduce((a, d) => a + d.length, 0)} bytes of data` : "null"}${ownerViewHasCode ? " (owner view carries the bytecode)" : ""}`,
        expected: "no strategy bytecode in the transaction",
        pass: hits.length === 0,
      });
    } else {
      /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
      const list: any[] = (await rpc(freshUrl, "getSignaturesForAddress", [target.toBase58(), { limit: SCAN_LIMIT }])).result ?? [];
      let readable = 0;
      for (const s of list) {
        const t = await getTx(freshUrl, s.signature);
        if (txInstructionData(t.result).some(isSetStrategy) || (stratSecrets.length > 0 && scanValue(t.result, stratSecrets))) readable++;
      }
      push({
        path: "set_strategy tx → stranger getTransaction",
        who: "a stranger's token",
        request: `stranger getSignaturesForAddress(owner) + getTransaction on ${list.length} tx`,
        result: readable
          ? `LEAK: ${readable} tx expose set_strategy data${settled ? " — settle_entrant closed the permission, and with it the TX_MESSAGE filter that redacted this upload while the round ran" : ""}`
          : `${list.length} tx scanned, no readable set_strategy data${ownerUrl ? "" : " (no owner token to pin the upload)"}`,
        expected: "no strategy bytecode in the transaction",
        pass: readable === 0,
      });
    }
  }

  // ---- 7. L1 committed Strategy / Position are zeroed ------------------------
  {
    const { info: acc, error } = await tryInfo(l1, strat);
    let result: string;
    let pass: boolean;
    let expected = "owned by delegation program, bytecode region all zero";
    if (!acc) {
      pass = settled && !error;
      result = error ? `error: ${error}` : "absent on L1";
      if (settled) expected = "settled: scrubbed or closed";
    } else {
      const region = strategyRegion(acc.data);
      const delegated = acc.owner.equals(DELEGATION_PROGRAM_ID);
      const undelegated = acc.owner.equals(PROGRAM_ID);
      const zeroed = allZero(region);
      const leaked = stratSecrets.some((s) => containsSecret(region, s));
      const ownerLabel = delegated ? "delegation program" : undelegated ? "BLACKBOX (undelegated)" : acc.owner.toBase58().slice(0, 8);
      if (undelegated) expected = "undelegated only after settlement, body scrubbed";
      pass = zeroed && !leaked && (delegated || (undelegated && settled && allZero(acc.data.subarray(8))));
      result = `owner=${ownerLabel}, region[${STRATEGY_BYTECODE_OFFSET}..]=${zeroed ? "all zero" : `${leaked ? "LEAK " : ""}${hex(region)}…`}`;
    }
    push({ path: "L1 getAccountInfo → Strategy", who: "anyone on Solana L1", request: `L1 getAccountInfo(${shortStrat})`, result, expected, pass });

    const { info: accP, error: ep } = await tryInfo(l1, pos);
    const pregion = accP ? positionRegion(accP.data) : null;
    const pzero = !!pregion && allZero(pregion);
    const pleak = !!pregion && posSecrets.some((s) => containsSecret(pregion, s));
    push({
      path: "L1 getAccountInfo → Position",
      who: "anyone on Solana L1",
      request: `L1 getAccountInfo(${shortPos})`,
      result: accP
        ? `owner=${accP.owner.equals(DELEGATION_PROGRAM_ID) ? "delegation program" : accP.owner.toBase58().slice(0, 8)}, trading state ${pzero ? "all zero" : `${pleak ? "LEAK (matches live state)" : "non-zero"} ${hex(pregion!)}…`}`
        : ep
          ? `error: ${ep}`
          : "absent on L1",
      expected: "no private trading state on L1 (never auto-committed)",
      pass: accP ? pzero : settled && !ep,
    });
  }

  // ---- 8. delegation buffer / record / metadata + permission PDAs on L1 ------
  for (const [label, acct, secrets, regionOf] of [
    ["Strategy", strat, stratSecrets, strategyRegion],
    ["Position", pos, posSecrets, positionRegion],
  ] as const) {
    const pdas = [
      { label: "delegate_buffer", key: delegateBufferPda(acct, PROGRAM_ID), buffer: true },
      { label: "delegation_record", key: delegationRecordPda(acct), buffer: false },
      { label: "delegation_metadata", key: delegationMetadataPda(acct), buffer: false },
      { label: "permission", key: permissionPda(acct), buffer: false },
    ];
    const reads = await Promise.all(pdas.map((p) => tryInfo(l1, p.key)));
    const leaks: string[] = [];
    const present: string[] = [];
    const errors: string[] = [];
    reads.forEach(({ info, error }, i) => {
      if (error) errors.push(`${pdas[i].label}: ${error}`);
      if (!info) return;
      present.push(`${pdas[i].label}(${info.data.length}B)`);
      const bufferLeak = pdas[i].buffer && info.data.length > STRATEGY_BYTECODE_OFFSET && !allZero(regionOf(info.data));
      if (bufferLeak || secrets.some((s) => containsSecret(info.data, s))) leaks.push(pdas[i].label);
    });
    push({
      path: `L1 delegation PDAs → ${label}`,
      who: "anyone on Solana L1",
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

  // ---- 9. raw (non-TEE) ER RPC ----------------------------------------------
  {
    const { info: raw, error } = await tryInfo(rawEr, strat);
    const region = raw ? strategyRegion(raw.data) : null;
    const hasCode = !!region && stratSecrets.some((s) => containsSecret(region, s));
    if (cluster === "local") {
      push({
        path: "raw ER RPC (7799) → Strategy",
        who: "a process on this machine (dev-only port)",
        request: `getAccountInfo(${shortStrat}) on the raw ER port 7799`,
        result: raw ? `${raw.data.length} bytes${hasCode ? ", bytecode readable" : ""} (internal port, not exposed in production)` : error ? `unreachable: ${error}` : "null",
        expected: "internal port, not exposed in production (informational)",
        pass: true,
      });
    } else {
      const leaked = !!region && (hasCode || (stratSecrets.length === 0 && !allZero(region)));
      push({
        path: "raw regional ER RPC → Strategy",
        who: "anyone (non-TEE regional rollup)",
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

  const failed = rows.filter((r) => !r.pass).length;
  return {
    cluster,
    round: round.toBase58(),
    target: target.toBase58(),
    targetName,
    ownerToken: !!ownerConn,
    rival: rival.entrant ? (wallet?.name ?? null) : null,
    rows,
    passed: rows.length - failed,
    failed,
    ms: Date.now() - t0,
    at: Date.now(),
  };
}
