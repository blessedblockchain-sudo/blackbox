"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";

const LINKS = [
  { href: "/arena", label: "Arena" },
  { href: "/studio", label: "Studio" },
  { href: "/back", label: "Back" },
  { href: "/proof", label: "Proof" },
  { href: "/hall", label: "Hall" },
  { href: "/disclosures", label: "Disclosures" },
];

export function BoxMark({ className }: { className?: string }) {
  // A sealed box: square outline with a keyhole. Decorative next to the wordmark.
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={className}>
      <rect x="0.75" y="0.75" width="14.5" height="14.5" fill="var(--color-void)" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="8" cy="6.5" r="1.6" fill="currentColor" />
      <rect x="7.25" y="7.5" width="1.5" height="3.5" fill="currentColor" />
    </svg>
  );
}

export function SiteNav() {
  const path = usePathname();
  return (
    <header className="sticky top-0 z-30 border-b border-edge bg-canvas/95 backdrop-blur-sm">
      <div className="mx-auto flex max-w-[1440px] flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2.5 sm:px-6">
        <Link href="/" className="flex items-center gap-2.5 rounded-[2px] py-1" aria-label="BLACKBOX home">
          <BoxMark className="size-4 text-fg" />
          <span className="font-mono text-[13px] font-bold tracking-[0.32em] text-fg">BLACKBOX</span>
          <span className="hidden text-[13px] text-fg-dim md:inline">Alpha you can&apos;t read.</span>
        </Link>
        <nav aria-label="Primary" className="-mx-2 flex items-center overflow-x-auto sm:ml-auto">
          {LINKS.map((l) => {
            const active = path === l.href || path.startsWith(`${l.href}/`);
            return (
              <Link
                key={l.href}
                href={l.href}
                aria-current={active ? "page" : undefined}
                className={clsx(
                  "relative flex min-h-10 items-center px-2.5 font-mono text-xs tracking-[0.08em] whitespace-nowrap uppercase transition-colors duration-150",
                  active ? "text-fg" : "text-fg-dim hover:text-fg",
                )}
              >
                {l.label}
                {active ? <span aria-hidden className="absolute inset-x-2.5 -bottom-[11px] h-px bg-gain" /> : null}
              </Link>
            );
          })}
        </nav>
        {path === "/" ? (
          <Link
            href="/arena"
            className="ml-auto inline-flex min-h-9 items-center rounded-[3px] bg-fg px-4 font-mono text-xs tracking-[0.06em] text-void transition-opacity duration-150 hover:opacity-88 sm:ml-0"
          >
            Open the app
          </Link>
        ) : null}
      </div>
    </header>
  );
}
