import type { Metadata } from "next";
import { Hall } from "../../components/hall/hall";

export const metadata: Metadata = { title: "Hall of Fame" };

export default function HallPage() {
  return <Hall />;
}
