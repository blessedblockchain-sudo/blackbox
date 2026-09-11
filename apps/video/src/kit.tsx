/**
 * Shared building blocks for both cuts: palette, captions, typeset terminal
 * output, stat rows and a browser frame for captured footage.
 *
 * Everything animates from useCurrentFrame(); no CSS transitions.
 */
import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

/** Palette taken from the web app (apps/web/app/globals.css). */
export const C = {
  canvas: "#09090b",
  surface: "#0e0e11",
  surface2: "#141418",
  void: "#050506",
  edge: "#1e1e24",
  edgeStrong: "#2e2e36",
  fg: "#ececee",
  fgMuted: "#a1a1aa",
  fgDim: "#71717a",
  sealed: "#9945FF",
  live: "#14F195",
  warn: "#e8b339",
  bad: "#e5484d",
} as const;

export const MONO = '"JetBrains Mono", "SF Mono", ui-monospace, monospace';
export const SANS = 'Inter, "SF Pro Display", system-ui, sans-serif';

/** Fade + rise, settling with no bounce. */
export function useEnter(delay = 0, distance = 18) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - delay, fps, config: { damping: 200 } });
  return { opacity: s, transform: `translateY(${interpolate(s, [0, 1], [distance, 0])}px)` };
}

/** Hold, then fade out over the last `out` frames of a window. */
export function useExit(windowLength: number, out = 12) {
  const frame = useCurrentFrame();
  return interpolate(frame, [windowLength - out, windowLength], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
}

export const Screen: React.FC<{ children: React.ReactNode; background?: string }> = ({ children, background = C.canvas }) => (
  <AbsoluteFill style={{ background, fontFamily: SANS, color: C.fg }}>{children}</AbsoluteFill>
);

/** One line of caption text at the bottom; the video is watched muted. */
export const Caption: React.FC<{ text: string; sub?: string; delay?: number }> = ({ text, sub, delay = 0 }) => {
  const enter = useEnter(delay);
  return (
    <div
      style={{
        position: "absolute",
        left: 120,
        right: 120,
        bottom: 34,
        padding: "18px 26px",
        borderRadius: 10,
        background: "rgba(5,5,6,0.92)",
        border: `1px solid ${C.edge}`,
        ...enter,
      }}
    >
      <div style={{ fontSize: 42, lineHeight: 1.15, fontWeight: 600, letterSpacing: -0.5 }}>{text}</div>
      {sub ? <div style={{ marginTop: 10, fontSize: 25, color: C.fgMuted, fontFamily: MONO }}>{sub}</div> : null}
    </div>
  );
};

/** Small label in the top-left corner, e.g. "devnet · MagicBlock TEE validator". */
export const Slug: React.FC<{ text: string; delay?: number }> = ({ text, delay = 0 }) => {
  const enter = useEnter(delay, 8);
  return (
    <div
      style={{
        position: "absolute",
        top: 18,
        left: 120,
        fontFamily: MONO,
        fontSize: 22,
        color: C.fgMuted,
        border: `1px solid ${C.edge}`,
        background: "rgba(9,9,11,0.72)",
        padding: "8px 14px",
        borderRadius: 6,
        ...enter,
      }}
    >
      {text}
    </div>
  );
};

/** Captured page footage inside a restrained browser frame. */
export const BrowserFrame: React.FC<{ url: string; children: React.ReactNode; delay?: number }> = ({ url, children, delay = 0 }) => {
  const enter = useEnter(delay, 24);
  return (
    <div
      style={{
        position: "absolute",
        left: 180,
        right: 180,
        top: 72,
        borderRadius: 14,
        overflow: "hidden",
        border: `1px solid ${C.edgeStrong}`,
        background: C.void,
        boxShadow: "0 40px 120px rgba(0,0,0,0.65)",
        ...enter,
      }}
    >
      <div style={{ height: 46, background: C.surface2, borderBottom: `1px solid ${C.edge}`, display: "flex", alignItems: "center", gap: 10, padding: "0 16px" }}>
        {[C.bad, C.warn, C.live].map((c) => (
          <div key={c} style={{ width: 11, height: 11, borderRadius: 6, background: c, opacity: 0.55 }} />
        ))}
        <div style={{ marginLeft: 14, fontFamily: MONO, fontSize: 19, color: C.fgDim }}>{url}</div>
      </div>
      <div style={{ position: "relative", aspectRatio: "16 / 9" }}>{children}</div>
    </div>
  );
};

/** Real terminal output, typeset rather than screen-captured so it stays legible. */
export const Terminal: React.FC<{ lines: { text: string; tone?: "pass" | "fail" | "dim" | "head" }[]; title?: string; perLine?: number; delay?: number }> = ({
  lines,
  title,
  perLine = 3,
  delay = 0,
}) => {
  const frame = useCurrentFrame();
  const enter = useEnter(delay, 20);
  const tone = (t?: string) => (t === "pass" ? C.live : t === "fail" ? C.bad : t === "head" ? C.fg : C.fgMuted);
  return (
    <div
      style={{
        position: "absolute",
        left: 120,
        right: 120,
        top: 150,
        background: C.void,
        border: `1px solid ${C.edgeStrong}`,
        borderRadius: 12,
        padding: "26px 32px",
        fontFamily: MONO,
        fontSize: 25,
        lineHeight: 1.5,
        ...enter,
      }}
    >
      {title ? <div style={{ color: C.fgDim, marginBottom: 14 }}>{title}</div> : null}
      {lines.map((l, i) => {
        const shown = frame >= delay + 6 + i * perLine;
        return (
          <div key={i} style={{ color: tone(l.tone), opacity: shown ? 1 : 0, whiteSpace: "pre" }}>
            {l.text}
          </div>
        );
      })}
    </div>
  );
};

/** One number with its label; the hook lives here, not in a map callback. */
const Stat: React.FC<{ value: string; label: string; delay: number }> = ({ value, label, delay }) => {
  const enter = useEnter(delay, 22);
  return (
    <div style={{ textAlign: "center", ...enter }}>
      <div style={{ fontSize: 92, fontWeight: 700, letterSpacing: -2, fontFamily: MONO }}>{value}</div>
      <div style={{ marginTop: 8, fontSize: 26, color: C.fgMuted }}>{label}</div>
    </div>
  );
};

/** Three or four numbers, entering in sequence. */
export const Stats: React.FC<{ items: { value: string; label: string }[]; delay?: number }> = ({ items, delay = 0 }) => (
  <div style={{ position: "absolute", left: 96, right: 96, top: "38%", display: "flex", gap: 72, justifyContent: "center" }}>
    {items.map((it, i) => (
      <Stat key={it.label} value={it.value} label={it.label} delay={delay + i * 8} />
    ))}
  </div>
);

/** Title card: big line, small line under it. */
export const Title: React.FC<{ line: string; sub?: string; delay?: number }> = ({ line, sub, delay = 0 }) => {
  const enter = useEnter(delay, 26);
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
      <div style={{ textAlign: "center", ...enter }}>
        <div style={{ fontSize: 122, fontWeight: 700, letterSpacing: -4 }}>{line}</div>
        {sub ? <div style={{ marginTop: 22, fontSize: 34, color: C.fgMuted, fontFamily: MONO }}>{sub}</div> : null}
      </div>
    </AbsoluteFill>
  );
};
