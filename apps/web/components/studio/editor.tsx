"use client";
import { useCallback, useRef, useState, type KeyboardEvent } from "react";
import clsx from "clsx";

export interface Diagnostic {
  line: number;
  col: number;
  message: string;
  severity: "error" | "warning";
}

const LINE_H = 20; // px, matches leading-5

/**
 * BXL editor: a monospace textarea with a line-number gutter and inline
 * diagnostics (gutter markers, line bands, and a clickable list). Tab indents;
 * press Escape first to move focus out with Tab.
 */
export function BxlEditor({ value, onChange, diagnostics, id = "bxl-source" }: { value: string; onChange: (v: string) => void; diagnostics: Diagnostic[]; id?: string }) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const [scroll, setScroll] = useState(0);
  const tabEscapes = useRef(false);
  const lines = value.split("\n");
  const byLine = new Map<number, Diagnostic>();
  for (const d of diagnostics) {
    const prev = byLine.get(d.line);
    if (!prev || (prev.severity === "warning" && d.severity === "error")) byLine.set(d.line, d);
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") {
      tabEscapes.current = true;
      return;
    }
    if (e.key === "Tab" && !e.shiftKey && !tabEscapes.current && !e.altKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      const el = e.currentTarget;
      const { selectionStart: a, selectionEnd: b } = el;
      const next = value.slice(0, a) + "  " + value.slice(b);
      onChange(next);
      requestAnimationFrame(() => {
        el.selectionStart = el.selectionEnd = a + 2;
      });
      return;
    }
    tabEscapes.current = false;
  };

  const jump = useCallback(
    (d: Diagnostic) => {
      const el = ta.current;
      if (!el) return;
      const ls = value.split("\n");
      let off = 0;
      for (let i = 0; i < Math.min(d.line - 1, ls.length); i++) off += ls[i].length + 1;
      off += Math.max(0, d.col - 1);
      el.focus();
      el.setSelectionRange(off, off);
      el.scrollTop = Math.max(0, (d.line - 3) * LINE_H);
    },
    [value],
  );

  const errors = diagnostics.filter((d) => d.severity === "error");
  return (
    <div>
      <div className="relative flex h-[340px] overflow-hidden border-b border-edge bg-void font-mono text-[13px] leading-5">
        <div aria-hidden className="w-11 shrink-0 overflow-hidden border-r border-edge py-2 text-right select-none">
          <div style={{ transform: `translateY(${-scroll}px)` }}>
            {lines.map((_, i) => {
              const d = byLine.get(i + 1);
              return (
                <div key={i} className={clsx("num relative pr-2", d ? (d.severity === "error" ? "text-loss" : "text-warn") : "text-fg-faint")} style={{ height: LINE_H }}>
                  {d ? <span className={clsx("absolute top-1.5 left-1 size-1.5 rounded-full", d.severity === "error" ? "bg-loss" : "bg-warn")} /> : null}
                  {i + 1}
                </div>
              );
            })}
          </div>
        </div>
        <div className="relative min-w-0 flex-1">
          <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden py-2">
            <div style={{ transform: `translateY(${-scroll}px)` }}>
              {lines.map((_, i) => {
                const d = byLine.get(i + 1);
                return <div key={i} style={{ height: LINE_H }} className={clsx(d && (d.severity === "error" ? "bg-loss/10" : "bg-warn/5"))} />;
              })}
            </div>
          </div>
          <label htmlFor={id} className="sr-only">
            BXL strategy source
          </label>
          <textarea
            ref={ta}
            id={id}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            onScroll={(e) => setScroll(e.currentTarget.scrollTop)}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            wrap="off"
            aria-invalid={errors.length > 0}
            aria-describedby={`${id}-diagnostics`}
            className="absolute inset-0 resize-none overflow-auto bg-transparent px-3 py-2 whitespace-pre text-fg caret-gain outline-none placeholder:text-fg-faint focus-visible:outline-none"
            style={{ lineHeight: `${LINE_H}px`, tabSize: 2 }}
          />
        </div>
      </div>
      <div id={`${id}-diagnostics`} aria-live="polite">
        {diagnostics.length ? (
          <ul className="max-h-32 overflow-auto">
            {diagnostics.map((d, i) => (
              <li key={i} className="border-b border-edge last:border-b-0">
                <button onClick={() => jump(d)} className="flex min-h-9 w-full items-baseline gap-3 px-3 py-1.5 text-left text-xs transition-colors duration-150 hover:bg-surface-2">
                  <span className={clsx("num shrink-0", d.severity === "error" ? "text-loss" : "text-warn")}>
                    {d.severity === "error" ? "error" : "warn"} {d.line}:{d.col}
                  </span>
                  <span className="text-fg-muted">{d.message}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
