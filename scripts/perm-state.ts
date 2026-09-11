import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { getAuthToken, permissionPdaFromAccount, getPermissionStatus } from "@magicblock-labs/ephemeral-rollups-sdk";
import * as nacl from "tweetnacl";
async function main() {
  const teeUrl = "https://devnet-tee.magicblock.app";
  const payer = anchor.Wallet.local().payer;
  const tok = await getAuthToken(teeUrl, payer.publicKey, (m: Uint8Array) => Promise.resolve(nacl.sign.detached(m, payer.secretKey)));
  const conn = new Connection(`${teeUrl}?token=${tok.token}`, "confirmed");
  const vault = new PublicKey(process.argv[2]);
  const perm = permissionPdaFromAccount(vault);
  const info = await conn.getAccountInfo(perm, "processed");
  console.log("permission", perm.toBase58(), info ? `len=${info.data.length} lamports=${info.lamports} owner=${info.owner.toBase58()} hex=${info.data.toString("hex").slice(0, 120)}` : "null");
  try { console.log("getPermissionStatus:", JSON.stringify(await (getPermissionStatus as any)(conn, vault))); } catch (e: any) { console.log("getPermissionStatus err", e.message?.slice(0, 100)); }
}
main().then(() => process.exit(0));
