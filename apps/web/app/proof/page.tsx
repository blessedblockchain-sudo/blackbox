import type { Metadata } from "next";
import { Proof } from "../../components/proof/proof";

export const metadata: Metadata = { title: "Privacy proof" };

export default function ProofPage() {
  return <Proof />;
}
