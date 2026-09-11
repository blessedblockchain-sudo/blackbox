import type { Metadata } from "next";
import { WalletShell } from "../../components/wallet-shell";
import { Studio } from "../../components/studio/studio";

export const metadata: Metadata = { title: "Studio" };

export default function StudioPage() {
  return (
    <WalletShell>
      <Studio />
    </WalletShell>
  );
}
