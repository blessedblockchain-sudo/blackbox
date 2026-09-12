import type { Metadata } from "next";
import { Proof } from "../../components/proof/proof";
import { Shell } from "../../components/shell";
import { WalletShell } from "../../components/wallet-shell";

export const metadata: Metadata = { title: "Privacy proof" };

export default function ProofPage() {
  return (
    <WalletShell>
      <Shell>
        <Proof />
      </Shell>
    </WalletShell>
  );
}
