"use client";
import { useMemo, type ReactNode } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { ENDPOINTS } from "@blackbox/sdk/src/constants";

/**
 * Wallet Standard discovery only (wallets = []): Phantom, Solflare, Backpack
 * and others register themselves. No auto-connect: the user picks explicitly.
 */
export function WalletShell({ children }: { children: ReactNode }) {
  const endpoint = useMemo(() => {
    const c = process.env.NEXT_PUBLIC_CLUSTER === "devnet" ? "devnet" : "local";
    return process.env.NEXT_PUBLIC_BASE_RPC ?? ENDPOINTS[c].base;
  }, []);
  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={[]} autoConnect={false}>
        {children}
      </WalletProvider>
    </ConnectionProvider>
  );
}
