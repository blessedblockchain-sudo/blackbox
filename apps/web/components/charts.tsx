import clsx from "clsx";

function path(values: number[], w: number, h: number, pad: number, lo: number, hi: number): string {
  const span = hi - lo || 1;
  const step = values.length > 1 ? (w - pad * 2) / (values.length - 1) : 0;
  return values
    .map((v, i) => {
      const x = pad + i * step;
      const y = pad + (h - pad * 2) * (1 - (v - lo) / span);
      return `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join("");
}

/**
 * Minimal sparkline. Color follows direction against `baseline` (or the first
 * point). `baseline` draws a dashed reference, e.g. the deposit level.
 */
export function Sparkline({
  values,
  baseline,
  width = 240,
  height = 40,
  className,
  tone,
  label,
}: {
  values: number[];
  baseline?: number;
  width?: number;
  height?: number;
  className?: string;
  tone?: "gain" | "loss" | "neutral";
  label?: string;
}) {
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length < 2) {
    return (
      <svg viewBox={`0 0 ${width} ${height}`} className={clsx("block w-full", className)} role="img" aria-label={label ?? "no history yet"} preserveAspectRatio="none">
        <line x1={0} x2={width} y1={height / 2} y2={height / 2} stroke="var(--color-edge-strong)" strokeDasharray="2 4" />
      </svg>
    );
  }
  const ref = baseline ?? clean[0];
  let lo = Math.min(...clean, ref);
  let hi = Math.max(...clean, ref);
  if (hi - lo < Math.abs(ref) * 1e-4) {
    lo -= Math.abs(ref) * 5e-5 || 1;
    hi += Math.abs(ref) * 5e-5 || 1;
  }
  const last = clean[clean.length - 1];
  const t = tone ?? (last > ref ? "gain" : last < ref ? "loss" : "neutral");
  const stroke = t === "gain" ? "var(--color-gain)" : t === "loss" ? "var(--color-loss)" : "var(--color-fg-muted)";
  const pad = 2;
  const d = path(clean, width, height, pad, lo, hi);
  const refY = pad + (height - pad * 2) * (1 - (ref - lo) / (hi - lo || 1));
  const area = `${d}L${(width - pad).toFixed(2)},${refY.toFixed(2)}L${pad},${refY.toFixed(2)}Z`;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className={clsx("block w-full", className)} role="img" aria-label={label ?? `${clean.length} samples`} preserveAspectRatio="none">
      <path d={area} fill={stroke} fillOpacity={0.07} />
      <line x1={0} x2={width} y1={refY} y2={refY} stroke="var(--color-edge-strong)" strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />
      <path d={d} fill="none" stroke={stroke} strokeWidth={1.25} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

/** Larger line chart with min/max/last labels, for the simulator and market detail. */
export function LineChart({
  series,
  height = 180,
  baseline,
  format,
  className,
  label,
}: {
  series: { values: number[]; color: string; name: string }[];
  height?: number;
  baseline?: number;
  format: (v: number) => string;
  className?: string;
  label: string;
}) {
  const all = series.flatMap((s) => s.values).filter(Number.isFinite);
  const width = 640;
  if (all.length < 2) {
    return <div className={clsx("grid place-items-center border border-dashed border-edge text-xs text-fg-dim", className)} style={{ height }}>No data to plot</div>;
  }
  let lo = Math.min(...all, baseline ?? Infinity);
  let hi = Math.max(...all, baseline ?? -Infinity);
  if (hi - lo < 1e-9) {
    lo -= 1;
    hi += 1;
  }
  const pad = 6;
  const baseY = baseline !== undefined ? pad + (height - pad * 2) * (1 - (baseline - lo) / (hi - lo)) : null;
  return (
    <figure className={clsx("relative", className)}>
      <svg viewBox={`0 0 ${width} ${height}`} className="block h-auto w-full" role="img" aria-label={label} preserveAspectRatio="none" style={{ height }}>
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1={0} x2={width} y1={pad + (height - pad * 2) * f} y2={pad + (height - pad * 2) * f} stroke="var(--color-edge)" vectorEffect="non-scaling-stroke" />
        ))}
        {baseY !== null ? <line x1={0} x2={width} y1={baseY} y2={baseY} stroke="var(--color-fg-faint)" strokeDasharray="3 4" vectorEffect="non-scaling-stroke" /> : null}
        {series.map((s) => (
          <path key={s.name} d={path(s.values, width, height, pad, lo, hi)} fill="none" stroke={s.color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        ))}
      </svg>
      <div className="pointer-events-none absolute inset-y-0 right-1 flex flex-col justify-between py-1 text-right">
        <span className="num text-[11px] text-fg-dim">{format(hi)}</span>
        <span className="num text-[11px] text-fg-dim">{format(lo)}</span>
      </div>
    </figure>
  );
}
