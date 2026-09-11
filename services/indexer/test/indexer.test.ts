import { expect } from "chai";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { Poller } from "../src/poller";
import { createServer } from "../src/server";
import { RoundStore, INDEXER_DIR } from "../src/store";
import { Sample } from "../src/types";

const ROOT = path.resolve(__dirname, "../../..");

function get(port: number, urlPath: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: urlPath }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : null }));
    }).on("error", reject);
  });
}

function sample(tick: number): Sample {
  return { t: Date.now(), tick, phase: "live", marks: [1, 2, 3], equities: [{ owner: "A", equity: 100, alive: true, trades: tick }] };
}

describe("RoundStore", () => {
  const round = `TEST${Date.now()}`;
  const file = path.join(INDEXER_DIR, `${round}.jsonl`);
  after(() => { try { fs.unlinkSync(file); } catch {} });

  it("appends only on new ticks and persists to jsonl", () => {
    const s = new RoundStore(round);
    expect(s.append(sample(1))).to.equal(true);
    expect(s.append(sample(2))).to.equal(true);
    expect(s.append(sample(2))).to.equal(false); // duplicate tick
    expect(s.count()).to.equal(2);
    expect(fs.readFileSync(file, "utf8").trim().split("\n").length).to.equal(2);
  });

  it("history(since) filters by tick and backfills from disk", () => {
    const s = new RoundStore(round); // re-open: backfills the two persisted lines
    expect(s.count()).to.equal(2);
    expect(s.history(1).map((x) => x.tick)).to.deep.equal([2]);
    expect(s.history().length).to.equal(2);
    expect(s.latest()?.tick).to.equal(2);
  });

  it("notifies subscribers of new samples", () => {
    const s = new RoundStore(round);
    const seen: number[] = [];
    const unsub = s.subscribe((x) => seen.push(x.tick));
    s.append(sample(3));
    unsub();
    s.append(sample(4));
    expect(seen).to.deep.equal([3]);
  });
});

describe("indexer HTTP server against the live local round", function () {
  this.timeout(30_000);
  const roundFile = path.join(ROOT, ".mb/round-local.json");
  const hasRound = fs.existsSync(roundFile);
  let server: http.Server;
  let poller: Poller;
  let port = 0;

  before(async function () {
    if (!hasRound) this.skip();
    poller = new Poller({ cluster: "local", intervalMs: 500, roundFile });
    await poller.pollOnce(); // one synchronous sample so endpoints have data
    poller.start();
    server = createServer(poller);
    await new Promise<void>((r) => server.listen(0, r));
    port = (server.address() as any).port;
    // Let a couple more ticks land.
    await new Promise((r) => setTimeout(r, 1500));
  });

  after(() => {
    poller?.stop();
    server?.close();
  });

  it("GET /health reports the current round", async () => {
    const { status, body } = await get(port, "/health");
    expect(status).to.equal(200);
    expect(body.ok).to.equal(true);
    expect(body.currentRound).to.be.a("string");
  });

  it("GET /rounds/current returns round info and a latest sample", async () => {
    const { status, body } = await get(port, "/rounds/current");
    expect(status).to.equal(200);
    expect(body.info.round).to.equal(poller.currentRound);
    expect(body.info.nMarkets).to.be.greaterThan(0);
    expect(body.latest).to.not.equal(null);
    expect(body.latest.marks.length).to.equal(body.info.nMarkets);
  });

  it("GET /rounds/:round/history?since filters samples", async () => {
    const round = poller.currentRound!;
    const all = await get(port, `/rounds/${round}/history`);
    expect(all.status).to.equal(200);
    expect(all.body.count).to.be.greaterThan(0);
    const mid = all.body.samples[0].tick;
    const since = await get(port, `/rounds/${round}/history?since=${mid}`);
    expect(since.body.samples.every((s: Sample) => s.tick > mid)).to.equal(true);
  });

  it("GET unknown round -> 404", async () => {
    const { status } = await get(port, "/rounds/DEADBEEF/history");
    expect(status).to.equal(404);
  });

  it("SSE /rounds/:round/stream pushes samples", async () => {
    const round = poller.currentRound!;
    const chunks = await new Promise<string>((resolve, reject) => {
      const req = http.get({ host: "127.0.0.1", port, path: `/rounds/${round}/stream`, headers: { Accept: "text/event-stream" } }, (res) => {
        let buf = "";
        res.on("data", (c) => {
          buf += c;
          if (buf.includes("event: sample")) { req.destroy(); resolve(buf); }
        });
        res.on("error", () => resolve(buf));
      });
      req.on("error", reject);
      setTimeout(() => { req.destroy(); resolve(""); }, 6000);
    });
    expect(chunks).to.include("event: sample");
    expect(chunks).to.include('"tick"');
  });
});
