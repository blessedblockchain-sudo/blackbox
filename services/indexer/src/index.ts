/**
 * BLACKBOX indexer entrypoint.
 *
 *   CLUSTER=local|devnet  INDEXER_PORT=8787  POLL_MS=500
 *   ts-node --transpile-only src/index.ts
 */
import { Cluster } from "@blackbox/sdk";
import { Poller } from "./poller";
import { createServer } from "./server";

export { Poller } from "./poller";
export { createServer } from "./server";
export { RoundStore, StoreRegistry } from "./store";
export type { Sample, EquityPoint, RoundInfo } from "./types";

function main() {
  const cluster = (process.env.CLUSTER || "local") as Cluster;
  const port = Number(process.env.INDEXER_PORT || 8787);
  const intervalMs = Number(process.env.POLL_MS || 500);
  const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 23), ...a);

  const poller = new Poller({ cluster, intervalMs, log });
  poller.start();
  const server = createServer(poller);
  server.listen(port, () => log(`indexer listening on :${port} (cluster ${cluster}, poll ${intervalMs}ms)`));

  const shutdown = () => {
    log("shutting down");
    poller.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (require.main === module) main();
