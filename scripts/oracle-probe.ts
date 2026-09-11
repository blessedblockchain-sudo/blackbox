// Probe where MagicBlock's Pyth Lazer feed accounts actually live and how fresh they are on each endpoint.
import { Connection, PublicKey } from "@solana/web3.js";
const FEEDS: Record<string, string> = {
  "SOL/USD": "ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu",
  "BTC/USD": "71wtTRDY8Gxgw56bXFt2oc6qeAbTxzStdNiC425Z51sr",
  "ETH/USD": "5vaYr1hpv8yrSpu8w3K95x22byYxUJCCNCSYJtqVWPvG",
};
const ENDPOINTS: Record<string, string> = {
  L1: "https://api.devnet.solana.com",
  router: "https://devnet-router.magicblock.app",
  eu: "https://devnet-eu.magicblock.app",
  us: "https://devnet-us.magicblock.app",
  as: "https://devnet-as.magicblock.app",
  tee: "https://devnet-tee.magicblock.app",
};
function decode(data: Buffer) {
  const tag = data[40];
  const off = tag === 0 ? 42 : 41;
  const p = off + 32;
  const price = data.readBigInt64LE(p);
  const expo = data.readInt32LE(p + 16);
  const publish = Number(data.readBigInt64LE(p + 20));
  return { price: Number(price) * 10 ** expo, publish, ageS: Math.round(Date.now() / 1000 - publish) };
}
async function main() {
  for (const [name, addr] of Object.entries(FEEDS)) {
    const key = new PublicKey(addr);
    console.log(`\n== ${name} ${addr}`);
    try {
      const r = await fetch(ENDPOINTS.router, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getDelegationStatus", params: [addr] }) });
      const j: any = await r.json();
      console.log("  delegation:", JSON.stringify(j.result ?? j.error));
    } catch (e: any) { console.log("  delegation: err", e.message); }
    for (const [ep, url] of Object.entries(ENDPOINTS)) {
      if (ep === "router") continue;
      try {
        const info = await new Connection(url, "processed").getAccountInfo(key, "processed");
        if (!info) { console.log(`  ${ep.padEnd(4)}: null`); continue; }
        const d = decode(info.data);
        console.log(`  ${ep.padEnd(4)}: owner=${info.owner.toBase58().slice(0, 8)} price=${d.price.toFixed(4)} age=${d.ageS}s`);
      } catch (e: any) { console.log(`  ${ep.padEnd(4)}: err ${String(e.message).slice(0, 80)}`); }
    }
  }
  // VRF ephemeral queue
  try {
    const r = await fetch(ENDPOINTS.router, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getDelegationStatus", params: ["5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc"] }) });
    console.log("\nVRF ephemeral queue delegation:", JSON.stringify(((await r.json()) as any).result));
  } catch {}
}
main().then(() => process.exit(0));
