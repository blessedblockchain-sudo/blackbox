/**
 * HTTP + SSE server exposing the indexer's per-round time series.
 *
 *   GET /health
 *   GET /rounds/current                    public round info + latest sample
 *   GET /rounds/:round/history?since=<tick> samples with tick > since
 *   GET /rounds/:round/stream               SSE, pushes each new sample
 *
 * CORS is open (Access-Control-Allow-Origin: *) so the web UI can read it.
 */
import * as http from "http";
import { Poller } from "./poller";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", ...CORS });
  res.end(payload);
}

export function createServer(poller: Poller): http.Server {
  return http.createServer((req, res) => {
    if (!req.url) return sendJson(res, 400, { error: "bad request" });
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS);
      return res.end();
    }
    const url = new URL(req.url, "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);

    // GET /health
    if (parts.length === 1 && parts[0] === "health") {
      return sendJson(res, 200, {
        ok: true,
        cluster: poller.cluster,
        currentRound: poller.currentRound,
        rounds: poller.registry.rounds().map((r) => ({ round: r, samples: poller.registry.peek(r)?.count() ?? 0 })),
        uptime: process.uptime(),
      });
    }

    // GET /rounds/current
    if (parts.length === 2 && parts[0] === "rounds" && parts[1] === "current") {
      const round = poller.currentRound;
      const store = round ? poller.registry.peek(round) : undefined;
      if (!round || !store || !store.info) return sendJson(res, 404, { error: "no current round yet" });
      return sendJson(res, 200, { info: store.info, latest: store.latest() });
    }

    // GET /rounds/:round/history?since=<tick>
    if (parts.length === 3 && parts[0] === "rounds" && parts[2] === "history") {
      const store = poller.registry.peek(parts[1]);
      if (!store) return sendJson(res, 404, { error: "unknown round" });
      const sinceRaw = url.searchParams.get("since");
      const since = sinceRaw == null ? -1 : Number(sinceRaw);
      if (Number.isNaN(since)) return sendJson(res, 400, { error: "since must be a number" });
      const samples = store.history(since);
      return sendJson(res, 200, { round: parts[1], since, count: samples.length, samples });
    }

    // GET /rounds/:round/stream  (SSE)
    if (parts.length === 3 && parts[0] === "rounds" && parts[2] === "stream") {
      const store = poller.registry.get(parts[1]);
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        ...CORS,
      });
      res.write(": connected\n\n");
      // Replay the latest sample so a fresh subscriber has immediate data.
      const latest = store.latest();
      if (latest) res.write(`event: sample\ndata: ${JSON.stringify(latest)}\n\n`);
      const unsub = store.subscribe((s) => {
        res.write(`event: sample\ndata: ${JSON.stringify(s)}\n\n`);
      });
      const beat = setInterval(() => res.write(": ping\n\n"), 15_000);
      const cleanup = () => {
        clearInterval(beat);
        unsub();
      };
      req.on("close", cleanup);
      req.on("error", cleanup);
      return;
    }

    return sendJson(res, 404, { error: "not found", path: url.pathname });
  });
}
