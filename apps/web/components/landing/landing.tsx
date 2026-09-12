import Link from "next/link";
import type { ReactNode } from "react";
import clsx from "clsx";
import { PROGRAM_EXPLORER, REPO_URL, asset } from "../../lib/config";
import { BoxMark } from "../site-nav";
import { LiveBadge } from "./live-badge";

/**
 * The product page. Ported from site/index.html onto the app's own tokens
 * (app/globals.css) so the landing and the app are one design, and so the
 * "Open the arena" buttons are real in-app links rather than a link out.
 */

function Wrap({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx("mx-auto w-full max-w-[1120px] px-5 sm:px-7", className)}>{children}</div>;
}

function CtaPrimary({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex min-h-11 items-center gap-2 rounded-[3px] bg-fg px-5 font-mono text-[13px] tracking-[0.04em] text-void transition-opacity duration-150 hover:opacity-88"
    >
      {children}
    </Link>
  );
}

/**
 * `next/link` applies `basePath`; a bare <a href="/back"> does not, and would
 * leave the site on a GitLab Pages sub-path. Only same-page anchors and
 * off-site URLs get a plain <a>.
 */
function CtaSecondary({ href, children, external = false }: { href: string; children: ReactNode; external?: boolean }) {
  const cls =
    "inline-flex min-h-11 items-center gap-2 rounded-[3px] border border-edge-strong px-5 font-mono text-[13px] tracking-[0.04em] text-fg transition-colors duration-150 hover:border-fg";
  if (external) {
    return (
      <a href={href} target="_blank" rel="noreferrer noopener" className={cls}>
        {children}
      </a>
    );
  }
  if (href.startsWith("#")) {
    return (
      <a href={href} className={cls}>
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={cls}>
      {children}
    </Link>
  );
}

const FEATURES: [string, string][] = [
  ["Sealed strategies", "Your code and positions are readable only with your own key. Rivals, spectators and the rollup operator get nothing back."],
  ["Real perps, live prices", "SOL, BTC and ETH books marked on Pyth Lazer prices, with spread, funding, leverage caps and liquidation."],
  ["Blind licensing", "Back an author's sealed strategy with your own margin. The enclave prices the fee from their private Sharpe ratio."],
  ["Settles on Solana", "Books close, fees and prizes pay out, each final strategy's hash is published, and results commit back to L1."],
];

const STEPS: [string, string][] = [
  ["Join and delegate", "Your accounts are created empty on Solana, then delegated to the TEE validator with timer commits off."],
  ["Seal and upload", "Permissions name you as the only reader. Your bytecode arrives in a rollup transaction whose message stays hidden."],
  ["Trade every tick", "The Native Crank runs your strategy in the enclave against live prices, marking your book and updating the public leaderboard."],
  ["Settle", "Books close, fees and prizes pay in real tokens, hashes are published, private state is zeroed, results commit to Solana."],
];

export function Landing() {
  return (
    <div className="text-[15px] leading-6">
      {/* Hero */}
      <section className="border-b border-edge py-20 sm:py-24">
        <Wrap>
          <LiveBadge />
          <h1 className="mt-6 max-w-[17ch] text-[clamp(2.5rem,6vw,4rem)] leading-[1.04] font-medium tracking-[-0.035em] text-fg">Alpha you can&apos;t read.</h1>
          <p className="mt-5 max-w-[62ch] text-[19px] leading-8 text-fg-muted">
            BLACKBOX is a trading league where every strategy is a sealed program. It runs inside a MagicBlock Private Ephemeral Rollup on every tick, trades perps against live Pyth prices, and settles
            on Solana. Everyone sees the equity curve. Nobody sees the code.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <CtaPrimary href="/arena">Open the app</CtaPrimary>
            <CtaSecondary href="#demo">Watch the demo</CtaSecondary>
            <CtaSecondary href={REPO_URL} external>
              View the code
            </CtaSecondary>
          </div>
        </Wrap>
      </section>

      {/* Product */}
      <section id="product" className="scroll-mt-14 border-b border-edge py-16 sm:py-20">
        <Wrap>
          <h2 className="text-[30px] leading-9 font-medium tracking-[-0.02em]">Built for traders who don&apos;t want to be copied</h2>
          <p className="mt-3 max-w-[62ch] text-fg-muted">
            Upload bytecode for an on-chain VM. The program executes it inside the enclave, marks your book against live oracle prices, and keeps the logic and your positions readable only by you.
          </p>
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {FEATURES.map(([title, body]) => (
              <div key={title} className="rounded-[3px] border border-edge bg-surface p-6">
                <h3 className="text-[17px] leading-6 font-medium tracking-[-0.01em]">{title}</h3>
                <p className="mt-2 text-fg-muted">{body}</p>
              </div>
            ))}
          </div>
        </Wrap>
      </section>

      {/* Demo */}
      <section id="demo" className="scroll-mt-14 border-b border-edge py-16 sm:py-20">
        <Wrap>
          <h2 className="text-[30px] leading-9 font-medium tracking-[-0.02em]">See a round</h2>
          <p className="mt-3 max-w-[62ch] text-fg-muted">Ninety seconds, filmed against a live devnet round on MagicBlock&apos;s TEE validator.</p>
          <figure className="mt-8 m-0">
            <video
              controls
              preload="metadata"
              poster={asset("/arena.png")}
              src={asset("/blackbox-90s.mp4")}
              className="block w-full rounded-[3px] border border-edge-strong bg-void"
            />
            <figcaption className="mt-3 text-[13.5px] text-fg-dim">The arena mid-round: sealed tiles, live marks, the mystery market drawn by VRF, and the solvency beacon.</figcaption>
          </figure>
        </Wrap>
      </section>

      {/* How it works */}
      <section id="how" className="scroll-mt-14 border-b border-edge py-16 sm:py-20">
        <Wrap>
          <h2 className="text-[30px] leading-9 font-medium tracking-[-0.02em]">How it works</h2>
          <p className="mt-3 max-w-[62ch] text-fg-muted">Four moves, from joining on Solana to settling back to it.</p>
          <ol className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map(([title, body], i) => (
              <li key={title} className="rounded-[3px] border border-edge bg-surface p-6">
                <span className="num block text-[13px] text-gain">{i + 1}</span>
                <strong className="mt-2.5 block font-medium">{title}</strong>
                <span className="mt-1.5 block text-fg-muted">{body}</span>
              </li>
            ))}
          </ol>
        </Wrap>
      </section>

      {/* Licensing */}
      <section id="licensing" className="scroll-mt-14 border-b border-edge py-16 sm:py-20">
        <Wrap className="grid items-center gap-10 lg:grid-cols-2 lg:gap-14">
          <div>
            <h2 className="text-[30px] leading-9 font-medium tracking-[-0.02em]">Licence alpha you can&apos;t see</h2>
            <p className="mt-3 max-w-[62ch] text-fg-muted">
              Back a strategy with your own margin and the enclave runs the author&apos;s code against your private book every tick. The fee is a price computed inside the TEE from the author&apos;s
              private Sharpe ratio — the only public trace of how they&apos;re doing.
            </p>
            <div className="mt-7">
              <CtaSecondary href="/back">Browse sealed strategies</CtaSecondary>
            </div>
          </div>
          <figure className="m-0">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={asset("/back.png")}
              alt="Sealed strategies ranked by blind price, with licence counts and public equity"
              loading="lazy"
              decoding="async"
              className="block w-full rounded-[3px] border border-edge-strong bg-void"
            />
          </figure>
        </Wrap>
      </section>

      {/* Closing CTA */}
      <section className="border-b border-edge py-20 text-center sm:py-24">
        <Wrap>
          <h2 className="text-[30px] leading-9 font-medium tracking-[-0.02em]">Put a strategy in the box</h2>
          <p className="mx-auto mt-3 max-w-[62ch] text-fg-muted">Open the arena, write one in BXL, and watch it trade without anyone reading it.</p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <CtaPrimary href="/arena">Open the app</CtaPrimary>
            <CtaSecondary href={REPO_URL} external>
              View the code
            </CtaSecondary>
          </div>
        </Wrap>
      </section>

      <footer className="py-10 pb-16 text-[14px] text-fg-dim">
        <Wrap>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <BoxMark className="size-4 text-fg-muted" />
            <Link href="/arena" className="text-fg-muted transition-colors duration-150 hover:text-fg">
              App
            </Link>
            <a href={REPO_URL} target="_blank" rel="noreferrer noopener" className="text-fg-muted transition-colors duration-150 hover:text-fg">
              Source
            </a>
            <a href={`${REPO_URL}/-/blob/main/docs/ARCHITECTURE.md`} target="_blank" rel="noreferrer noopener" className="text-fg-muted transition-colors duration-150 hover:text-fg">
              Architecture
            </a>
            <Link href="/disclosures" className="text-fg-muted transition-colors duration-150 hover:text-fg">
              Disclosures
            </Link>
            <a href={PROGRAM_EXPLORER} target="_blank" rel="noreferrer noopener" className="text-fg-muted transition-colors duration-150 hover:text-fg">
              Explorer
            </a>
            <a href={asset("/blackbox-90s.mp4")} className="text-fg-muted transition-colors duration-150 hover:text-fg">
              Download the demo
            </a>
          </div>
          <p className="mt-4">Running on Solana devnet with a test USDC mint. Built for MagicBlock&apos;s Solana Blitz v8.</p>
        </Wrap>
      </footer>
    </div>
  );
}
