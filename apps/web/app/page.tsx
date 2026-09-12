import type { Metadata } from "next";
import { Landing } from "../components/landing/landing";

export const metadata: Metadata = {
  title: { absolute: "BLACKBOX — sealed trading strategies on Solana" },
  description: "A trading league where every strategy runs sealed inside a MagicBlock Private Ephemeral Rollup, trades live perps, and settles on Solana.",
  openGraph: {
    title: "BLACKBOX — alpha you can't read",
    description: "Strategies run sealed inside a TEE, trade live perps on Pyth prices, and settle on Solana.",
  },
};

export default function HomePage() {
  return <Landing />;
}
