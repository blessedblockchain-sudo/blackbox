import clsx from "clsx";
import type { ComponentPropsWithoutRef, ReactNode } from "react";

export function Panel({ className, children, ...rest }: ComponentPropsWithoutRef<"section">) {
  return (
    <section className={clsx("border border-edge bg-surface", className)} {...rest}>
      {children}
    </section>
  );
}

export function PanelHeader({ title, meta, children, className }: { title: ReactNode; meta?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <header className={clsx("flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-edge px-3 py-2", className)}>
      <h2 className="label-caps !text-fg-muted">{title}</h2>
      {meta ? <div className="label-caps">{meta}</div> : null}
      {children}
    </header>
  );
}

type Tone = "neutral" | "gain" | "loss" | "warn" | "dim";
const toneClass: Record<Tone, string> = {
  neutral: "border-edge-strong text-fg",
  gain: "border-gain/40 bg-gain-deep text-gain",
  loss: "border-loss/40 bg-loss-deep text-loss",
  warn: "border-warn/40 bg-warn-deep text-warn",
  dim: "border-edge text-fg-dim",
};

export function Badge({ tone = "neutral", children, className, title }: { tone?: Tone; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={clsx("inline-flex items-center gap-1.5 rounded-[2px] border px-1.5 py-px font-mono text-[11px] leading-4 tracking-[0.08em] uppercase", toneClass[tone], className)}>
      {children}
    </span>
  );
}

export function Dot({ tone = "gain", pulse = false, className }: { tone?: Tone; pulse?: boolean; className?: string }) {
  const color = { neutral: "bg-fg", gain: "bg-gain", loss: "bg-loss", warn: "bg-warn", dim: "bg-fg-faint" }[tone];
  return <span aria-hidden className={clsx("inline-block size-1.5 shrink-0 rounded-full", color, pulse && "beacon", className)} />;
}

type ButtonVariant = "primary" | "secondary" | "ghost";
export function Button({ variant = "secondary", className, children, ...rest }: ComponentPropsWithoutRef<"button"> & { variant?: ButtonVariant }) {
  return (
    <button
      className={clsx(
        "inline-flex min-h-9 items-center justify-center gap-2 rounded-[2px] px-3 font-mono text-xs tracking-[0.06em] uppercase transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40",
        variant === "primary" && "bg-gain text-void hover:bg-gain/90 active:bg-gain/80",
        variant === "secondary" && "border border-edge-strong bg-surface-2 text-fg hover:border-fg-dim active:bg-edge",
        variant === "ghost" && "text-fg-muted hover:text-fg",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

export function ExtLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className={clsx("underline decoration-edge-strong underline-offset-4 transition-colors duration-150 hover:text-fg hover:decoration-fg-dim", className)}>
      {children}
    </a>
  );
}

/** Label over value, the base unit of every stat row. */
export function Stat({ label, children, className, hint }: { label: ReactNode; children: ReactNode; className?: string; hint?: ReactNode }) {
  return (
    <div className={clsx("min-w-0", className)}>
      <div className="label-caps">{label}</div>
      <div className="num mt-1 text-[15px] leading-5 text-fg">{children}</div>
      {hint ? <div className="mt-0.5 truncate text-xs text-fg-dim">{hint}</div> : null}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={clsx("skeleton rounded-[2px]", className)} />;
}
