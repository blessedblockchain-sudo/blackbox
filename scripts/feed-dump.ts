import { Connection, PublicKey } from "@solana/web3.js";
async function main() {
  const conn = new Connection("https://devnet-tee.magicblock.app", "processed");
  for (const [name, addr] of [["SOL/USD","ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu"],["BTC/USD","71wtTRDY8Gxgw56bXFt2oc6qeAbTxzStdNiC425Z51sr"]]) {
    const info = await conn.getAccountInfo(new PublicKey(addr), "processed");
    if (!info) { console.log(name, "null"); continue; }
    const d = info.data;
    console.log(`\n${name} len=${d.length} owner=${info.owner.toBase58()}`);
    console.log(" hex:", d.toString("hex").match(/.{1,64}/g)?.join("\n      "));
    console.log(" disc:", d.subarray(0,8).toString("hex"), " tag@40:", d[40]);
    for (const off of [41, 42]) {
      const p = off + 32;
      const price = d.readBigInt64LE(p), conf = d.readBigUInt64LE(p+8), expo = d.readInt32LE(p+16), pub = Number(d.readBigInt64LE(p+20)), prev = Number(d.readBigInt64LE(p+28)), ema = d.readBigInt64LE(p+36);
      console.log(` feed_off=${off}: price=${price} conf=${conf} expo=${expo} publish=${pub} (${new Date(pub*1000).toISOString()}) prev=${prev} ema=${ema}`);
    }
    // scan for a plausible unix timestamp (2026) at any offset
    const now = Math.floor(Date.now()/1000);
    for (let o = 0; o + 8 <= d.length; o++) { const v = Number(d.readBigInt64LE(o)); if (Math.abs(v - now) < 3600) console.log(`  plausible publish_time i64 at offset ${o}: ${v} (age ${now - v}s)`); }
  }
}
main().then(()=>process.exit(0));
