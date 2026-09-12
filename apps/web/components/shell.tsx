import clsx from "clsx";
import type { ReactNode } from "react";

/**
 * The app pages' container. The landing page sets its own full-bleed sections,
 * so this lives in the pages rather than in the root layout.
 */
export function Shell({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx("mx-auto max-w-[1440px] px-4 pt-4 pb-16 sm:px-6", className)}>{children}</div>;
}
