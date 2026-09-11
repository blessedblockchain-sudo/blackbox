import { expect } from "chai";
import * as fs from "fs";
import { Keypair, PublicKey } from "@solana/web3.js";
import { BlackboxClient } from "@blackbox/sdk";
import { runMatrix, Row } from "../src/matrix";
import { defaultRoundFile, loadRoundFile, selectTarget } from "../src/roundfile";
import { containsSecret, anySecret, allZero } from "../src/leak";

const CLUSTER = "local" as const;

describe("leak detection helpers", () => {
  it("finds a whole secret embedded in a larger blob", () => {
    const secret = Uint8Array.from([9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 11, 12, 13, 14, 15, 16, 17]);
    const hay = new Uint8Array(200);
    hay.set(secret, 40);
    expect(containsSecret(hay, secret)).to.equal(true);
  });

  it("finds a distinctive window of a long secret", () => {
    const secret = Uint8Array.from(Array.from({ length: 64 }, (_, i) => (i * 7 + 3) & 0xff));
    const hay = new Uint8Array(300);
    hay.set(secret.subarray(20, 40), 100); // only a middle slice leaks
    expect(containsSecret(hay, secret)).to.equal(true);
  });

  it("does not match on all-zero regions", () => {
    const secret = new Uint8Array(64); // all zero
    const hay = new Uint8Array(200); // also all zero
    expect(containsSecret(hay, secret)).to.equal(false);
    expect(allZero(hay)).to.equal(true);
  });

  it("anySecret scans multiple blobs and needles", () => {
    const s = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
    expect(anySecret([new Uint8Array(10), s], [s])).to.equal(true);
    expect(anySecret([new Uint8Array(10)], [s])).to.equal(false);
  });
});

describe("bx-attack privacy matrix against the live local round", function () {
  this.timeout(120_000);

  const file = defaultRoundFile(CLUSTER);
  const hasRound = fs.existsSync(file);
  let rows: Row[] = [];
  let phaseIsLive = false;
  let targetName = "";

  before(async function () {
    if (!hasRound) this.skip();
    const rf = loadRoundFile(file);
    const sel = selectTarget(rf, { index: 0 });
    targetName = sel.targetName;
    const bx = new BlackboxClient(Keypair.generate(), CLUSTER);
    const r: any = await bx.fetchRound(new PublicKey(rf.round));
    phaseIsLive = !!r && ("live" in r.status || "open" in r.status);
    rows = await runMatrix({
      cluster: CLUSTER,
      round: new PublicKey(rf.round),
      target: sel.target,
      ownerKp: sel.ownerKp,
      rivalKp: sel.rivalKp,
    });
    // Surface the full matrix in test output.
    for (const row of rows) console.log(`  [${row.pass ? "PASS" : "FAIL"}] ${row.path} — ${row.result}`);
  });

  it("produces a non-empty matrix covering strategy and position", () => {
    expect(rows.length).to.be.greaterThan(6);
    expect(rows.some((r) => /Strategy/.test(r.path))).to.equal(true);
    expect(rows.some((r) => /Position/.test(r.path))).to.equal(true);
  });

  it("no-token reads of Strategy and Position return null", () => {
    const noTok = rows.filter((r) => /no token/.test(r.path));
    expect(noTok.length).to.equal(2);
    for (const r of noTok) expect(r.pass, r.path + " " + r.result).to.equal(true);
  });

  it("a freshly generated wallet's token cannot read Strategy or Position", () => {
    const fresh = rows.filter((r) => /fresh token/.test(r.path));
    expect(fresh.length).to.equal(2);
    for (const r of fresh) expect(r.pass, r.path + " " + r.result).to.equal(true);
  });

  it("a rival entrant's token cannot read Strategy or Position", () => {
    const rival = rows.filter((r) => /rival token/.test(r.path));
    for (const r of rival) expect(r.pass, r.path + " " + r.result).to.equal(true);
  });

  it("the set_strategy transaction leaks no bytecode to a stranger", () => {
    const txRow = rows.find((r) => /set_strategy tx/.test(r.path));
    expect(txRow, "set_strategy row present").to.exist;
    expect(txRow!.pass, txRow!.result).to.equal(true);
  });

  it("the committed L1 Strategy is zeroed and delegation PDAs hold no bytecode", () => {
    const l1 = rows.find((r) => /^L1 getAccountInfo → Strategy/.test(r.path));
    const del = rows.find((r) => /^L1 delegation PDAs → Strategy/.test(r.path));
    expect(l1, "L1 Strategy row present").to.exist;
    expect(del, "L1 delegation PDAs row present").to.exist;
    expect(l1!.pass, l1!.result).to.equal(true);
    expect(del!.pass, del!.result).to.equal(true);
  });

  it("no attack path leaks any private byte (owner control excluded unless live)", () => {
    const leaks = rows.filter((r) => !r.pass && !/control/.test(r.path));
    expect(leaks.map((r) => `${r.path}: ${r.result}`)).to.deep.equal([]);
  });

  it("owner token IS able to read its own accounts while the round is live (control)", function () {
    const control = rows.filter((r) => /control/.test(r.path));
    if (control.length === 0 || !phaseIsLive) this.skip();
    for (const r of control) expect(r.pass, r.path + " " + r.result).to.equal(true);
  });
});
