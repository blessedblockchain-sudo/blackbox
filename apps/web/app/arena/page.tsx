import type { Metadata } from "next";
import { Arena } from "../../components/arena/arena";
import { Shell } from "../../components/shell";

export const metadata: Metadata = { title: "Arena" };

export default function ArenaPage() {
  return (
    <Shell>
      <Arena />
    </Shell>
  );
}
