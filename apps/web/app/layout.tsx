import type { Metadata, Viewport } from "next";
import { IBM_Plex_Sans, JetBrains_Mono } from "next/font/google";
import { SiteNav } from "../components/site-nav";
import "./globals.css";

const plex = IBM_Plex_Sans({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-plex", display: "swap" });
const jet = JetBrains_Mono({ subsets: ["latin"], weight: ["400", "500", "700"], variable: "--font-jet", display: "swap" });

export const metadata: Metadata = {
  title: { default: "BLACKBOX", template: "%s · BLACKBOX" },
  description: "A trading league where every strategy runs sealed inside a MagicBlock Private Ephemeral Rollup. Alpha you can't read.",
};

export const viewport: Viewport = { themeColor: "#09090b", colorScheme: "dark" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${plex.variable} ${jet.variable}`}>
      <body className="min-h-dvh bg-canvas font-sans text-[14px] leading-5 text-fg">
        <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:bg-surface-2 focus:px-3 focus:py-2">
          Skip to content
        </a>
        <SiteNav />
        <main id="main" className="mx-auto max-w-[1440px] px-4 pt-4 pb-16 sm:px-6">
          {children}
        </main>
      </body>
    </html>
  );
}
