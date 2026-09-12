"use client";
import { useLiveRound, useRoundInfo } from "../../lib/hooks";
import { formatInt } from "../../lib/format";
import { Dot } from "../ui";

const LABEL: Record<string, string> = {
  created: "round being created",
  open: "registration open",
  live: "round live",
  settling: "round settling",
  settled: "last round settled",
};

/**
 * The hero badge. It says what the chain actually says: the round the site is
 * pointed at, read from the TEE on load. No round, or no answer, and it falls
 * back to naming the cluster rather than claiming something is live.
 */
export function LiveBadge() {
  const { info } = useRoundInfo();
  const live = useLiveRound(info, 4000);
  const r = live.round;
  const running = r?.status === "live";
  const cluster = info?.cluster === "local" ? "local stack" : "Solana devnet";

  const text = r
    ? `${cluster} · round ${String(r.id).padStart(2, "0")} · ${LABEL[r.status] ?? r.status}${running ? ` · tick ${formatInt(r.tick)}/${formatInt(r.durationTicks)}` : ""}`
    : live.status === "error" || live.status === "missing"
      ? `${cluster} · no round reachable right now`
      : `${cluster} · reading the round…`;

  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-edge-strong px-3.5 py-1.5 font-mono text-[12px] text-fg-muted">
      <Dot tone={running ? "gain" : r ? "dim" : "warn"} pulse={running} />
      {text}
    </span>
  );
}
