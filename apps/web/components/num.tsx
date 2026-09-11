"use client";
import clsx from "clsx";
import type { ClipboardEvent } from "react";

/**
 * A formatted number. Always mono + tabular; copying it yields the raw value,
 * never the abbreviated display string.
 */
export function Num({ value, raw, className, title }: { value: string; raw?: number | string | null; className?: string; title?: string }) {
  const rawStr = raw === null || raw === undefined ? undefined : String(raw);
  const onCopy = (e: ClipboardEvent<HTMLSpanElement>) => {
    if (!rawStr) return;
    e.clipboardData.setData("text/plain", rawStr);
    e.preventDefault();
  };
  return (
    <span className={clsx("num", className)} title={title ?? rawStr} onCopy={onCopy}>
      {value}
    </span>
  );
}

const DIGITS = "0123456789";

/**
 * Odometer: each digit is a 0-9 column translated to its value, so changes roll
 * instead of snapping. Non-digit characters render statically. Columns are
 * keyed from the right, so the ones digit keeps its identity as width changes.
 */
export function Odometer({ value, className, label }: { value: string; className?: string; label?: string }) {
  const chars = value.split("");
  return (
    <span className={clsx("num odo", className)} aria-label={label ?? value} role="text">
      {chars.map((c, i) => {
        const key = chars.length - i;
        if (!DIGITS.includes(c)) {
          return (
            <span key={`s${key}`} aria-hidden className="odo-col">
              {c}
            </span>
          );
        }
        return (
          <span key={`d${key}`} aria-hidden className="odo-col">
            <span className="odo-strip" style={{ ["--d" as string]: Number(c) }}>
              {DIGITS.split("").map((d) => (
                <span key={d}>{d}</span>
              ))}
            </span>
          </span>
        );
      })}
    </span>
  );
}
