import type { Metadata } from "next";
import { WalletShell } from "../../components/wallet-shell";
import { Shell } from "../../components/shell";
import { Back } from "../../components/back/back";

export const metadata: Metadata = { title: "Back a strategy" };

export default function BackPage() {
  return (
    <WalletShell>
      <Shell>
        <Back />
      </Shell>
    </WalletShell>
  );
}
