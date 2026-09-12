import type { Metadata } from "next";
import { Hall } from "../../components/hall/hall";
import { Shell } from "../../components/shell";

export const metadata: Metadata = { title: "Hall of Fame" };

export default function HallPage() {
  return (
    <Shell>
      <Hall />
    </Shell>
  );
}
