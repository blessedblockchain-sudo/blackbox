// Fetch a transaction's logs from the TEE endpoint using the wallet's auth token.
import * as anchor from "@coral-xyz/anchor";
import { Connection } from "@solana/web3.js";
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";
import * as nacl from "tweetnacl";
async function main() {
  const sig = process.argv[2];
  const teeUrl = process.env.TEE_PROVIDER_ENDPOINT || "https://devnet-tee.magicblock.app";
  const payer = anchor.Wallet.local().payer;
  const tok = await getAuthToken(teeUrl, payer.publicKey, (m: Uint8Array) => Promise.resolve(nacl.sign.detached(m, payer.secretKey)));
  const conn = new Connection(`${teeUrl}?token=${tok.token}`, "confirmed");
  const tx = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  if (!tx) { console.log("null tx"); return; }
  console.log("err:", JSON.stringify(tx.meta?.err));
  console.log("accounts:", tx.transaction.message.staticAccountKeys?.map((k) => k.toBase58()) ?? (tx.transaction.message as any).accountKeys?.map((k: any) => k.toBase58()));
  for (const l of tx.meta?.logMessages ?? []) console.log("  ", l);
}
main().then(() => process.exit(0));
