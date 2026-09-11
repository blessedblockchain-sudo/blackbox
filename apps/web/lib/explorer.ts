/** Solana Explorer links for base-layer and TEE (ER) accounts and transactions. */
import { ENDPOINTS } from "@blackbox/sdk/src/constants";
import type { Cluster } from "./api-types";

const EXPLORER = "https://explorer.solana.com";

function clusterParam(cluster: Cluster, layer: "base" | "er", rpcOverride?: string): string {
  if (layer === "base" && cluster === "devnet" && !rpcOverride) return "cluster=devnet";
  const url = rpcOverride ?? (layer === "base" ? ENDPOINTS[cluster].base : ENDPOINTS[cluster].tee);
  return `cluster=custom&customUrl=${encodeURIComponent(url)}`;
}

export const baseAddressExplorer = (addr: string, cluster: Cluster, rpc?: string) => `${EXPLORER}/address/${addr}?${clusterParam(cluster, "base", rpc)}`;
export const baseTxExplorer = (sig: string, cluster: Cluster, rpc?: string) => `${EXPLORER}/tx/${sig}?${clusterParam(cluster, "base", rpc)}`;
export const erAddressExplorer = (addr: string, cluster: Cluster, rpc?: string) => `${EXPLORER}/address/${addr}?${clusterParam(cluster, "er", rpc)}`;
export const erTxExplorer = (sig: string, cluster: Cluster, rpc?: string) => `${EXPLORER}/tx/${sig}?${clusterParam(cluster, "er", rpc)}`;
