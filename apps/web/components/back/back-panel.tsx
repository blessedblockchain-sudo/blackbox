"use client";
import { useState, type FormEvent } from "react";
import type { PublicRoundInfo } from "../../lib/api-types";
import { MAX_LICENSES_PER_AUTHOR, lockedFeeBps, type MarketView, type RoundView } from "../../lib/chain";
import { checkRange, formatUsdcAmount, parseUsdcInput } from "../../lib/amount";
import { formatBps, formatInt, formatUsd, shortAddr } from "../../lib/format";
import { Button, Panel, PanelHeader, Stat } from "../ui";
import { rowBlock, type AuthorRow } from "./author-table";
import type { BackStateHandle } from "./use-back-state";
import { WalletBackFlow } from "./wallet-flow";

const LIFECYCLE: [string, string][] = [
  ["L1", "open_license and delegate_license create your License and hand it to the TEE validator."],
  ["L1 → ER", "Your USDC moves into the rollup with Ephemeral SPL."],
  ["ER", "activate_license makes the License private to you and the author, moves your margin in and locks the fee."],
  ["ER", "The Native Crank runs the author's sealed bytecode against your book every tick."],
  ["ER", "At round end, settle_license pays accrued fees to the author, returns the rest to you, and zeroes the License."],
];

function Lifecycle() {
  return (
    <ol className="space-y-2 px-3 py-3">
      {LIFECYCLE.map(([layer, text], i) => (
        <li key={i} className="flex gap-3 text-xs">
          <span className="num w-4 shrink-0 text-fg-faint">{i + 1}</span>
          <span className="label-caps w-14 shrink-0 !text-[10px]">{layer}</span>
          <span className="text-fg-muted">{text}</span>
        </li>
      ))}
    </ol>
  );
}

const PRESETS = ["100", "200", "500"];

function LocalBackForm({ author, round, block, back, lock }: { author: AuthorRow; round: RoundView | null; block: string | null; back: BackStateHandle; lock: number | null }) {
  const [margin, setMargin] = useState("200");
  const [touched, setTouched] = useState(false);
  const [phase, setPhase] = useState<"idle" | "confirm" | "sending">("idle");
  const [error, setError] = useState<string | null>(null);
  const d = back.data;
  const parsed = parseUsdcInput(margin);
  const rangeError = parsed.ok && round ? checkRange(parsed.micro, round.minMargin, round.maxMargin) : null;
  const erBal = d?.backer.usdcEr ?? null;
  const balanceError = parsed.ok && erBal !== null && parsed.value > erBal ? `The web backer has ${formatUsdcAmount(erBal)} USDC on the rollup; back with at most that much.` : null;
  const fieldError = !parsed.ok ? parsed.error : (rangeError ?? balanceError);
  const running = d?.jobs.some((j) => j.status === "running") ?? false;
  const disabledReason = block ?? (running ? "A license is being set up. Wait for it to finish." : null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    setError(null);
    if (fieldError || disabledReason) return;
    setPhase("confirm");
  };

  const send = async () => {
    setPhase("sending");
    setError(null);
    try {
      const res = await fetch("/api/local/back", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ author: author.owner, margin }),
      });
      const body = (await res.json()) as { job?: unknown; error?: string };
      if (!res.ok || body.error) throw new Error(body.error ?? `HTTP ${res.status}`);
      back.refresh();
      setPhase("idle");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("idle");
    }
  };

  const invalid = touched && !!fieldError;
  return (
    <form onSubmit={submit} noValidate className="space-y-3 border-t border-edge px-3 py-3">
      <div>
        <label htmlFor="back-margin" className="label-caps">
          Margin (USDC)
        </label>
        <div className="mt-1 flex flex-wrap items-stretch gap-1.5">
          <input
            id="back-margin"
            name="margin"
            type="text"
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            value={margin}
            onChange={(e) => {
              setMargin(e.target.value);
              if (phase === "confirm") setPhase("idle");
            }}
            onBlur={() => setTouched(true)}
            aria-invalid={invalid}
            aria-describedby={`back-margin-help${invalid ? " back-margin-error" : ""}`}
            className="num min-h-9 w-36 border border-edge-strong bg-void px-2 text-[15px] text-fg outline-none focus-visible:border-gain/60 aria-[invalid=true]:border-loss/60"
          />
          {PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => {
                setMargin(p);
                setTouched(true);
                if (phase === "confirm") setPhase("idle");
              }}
              className="num min-h-9 min-w-10 border border-edge px-2 text-xs text-fg-muted transition-colors duration-150 hover:border-edge-strong hover:text-fg"
              aria-label={`Set margin to ${p} USDC`}
            >
              {p}
            </button>
          ))}
        </div>
        <p id="back-margin-help" className="mt-1 text-xs text-fg-dim">
          {round ? `Between ${formatUsdcAmount(round.minMargin)} and ${formatUsdcAmount(round.maxMargin)} USDC. ` : ""}
          {erBal === null ? "The web backer deposits 2,000 USDC (or your margin, if larger) into the rollup once; later licenses draw on that balance." : `${formatUsdcAmount(erBal)} USDC available on the rollup.`}
        </p>
        {invalid ? (
          <p id="back-margin-error" role="alert" className="mt-1 text-xs text-loss">
            {fieldError}
          </p>
        ) : null}
      </div>

      {phase === "confirm" && parsed.ok ? (
        <div className="space-y-2.5 border border-edge-strong bg-void px-3 py-2.5 text-xs">
          <p className="text-fg-muted">
            The local server signs as the web backer and sends open_license and delegate_license on Solana,
            {erBal === null || parsed.value > erBal ? " deposits USDC into the rollup," : ""} then activate_license with {formatUsdcAmount(parsed.value)} USDC at{" "}
            {formatBps(lock, { decimals: 0 })} and schedule_license_tick on the rollup (the crank task is paid by the round admin).
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" type="button" onClick={send} autoFocus>
              Confirm: back {author.name} with {formatUsdcAmount(parsed.value)} USDC
            </Button>
            <Button variant="ghost" type="button" onClick={() => setPhase("idle")}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="primary" type="submit" disabled={!!disabledReason || phase === "sending"} aria-busy={phase === "sending"}>
          {phase === "sending" ? "Starting…" : `Back ${author.name}`}
        </Button>
      )}
      {disabledReason ? <p className="text-xs text-fg-dim">{disabledReason}</p> : null}
      {error ? (
        <p role="alert" className="border border-loss/30 bg-loss-deep px-3 py-2 text-xs break-words whitespace-pre-wrap text-loss">
          {error}
        </p>
      ) : null}
      <p className="text-[11px] leading-4 text-fg-dim">
        Signed on this machine by the local web backer{d ? ` ${shortAddr(d.backer.owner)}` : ""}; its key stays in {d?.backer.keyFile ?? ".mb/web"} and never reaches the browser. SOL and test USDC come from the
        local faucet (the round admin is the mint authority).
      </p>
    </form>
  );
}

export function BackPanel({
  info,
  round,
  author,
  gate,
  local,
  back,
  markets,
}: {
  info: PublicRoundInfo;
  round: RoundView | null;
  author: AuthorRow | null;
  gate: string | null;
  local: boolean;
  back: BackStateHandle;
  markets: (MarketView | null)[];
}) {
  if (!author) {
    return (
      <Panel aria-label="How backing works">
        <PanelHeader title="Pick a strategy to back" />
        <p className="px-3 pt-3 text-xs text-fg-dim">Choose a row. Here is what backing it does:</p>
        <Lifecycle />
      </Panel>
    );
  }
  const block = rowBlock(author, gate);
  const lock = author.feePriceBps === null || !round ? null : lockedFeeBps(author.feePriceBps, round.licenseFeeMinBps);
  return (
    <Panel aria-label={`Back ${author.name}`}>
      <PanelHeader title={`Back ${author.name}`} meta={shortAddr(author.owner)} />
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 px-3 py-3 sm:grid-cols-4">
        <Stat label="Blind price" hint="set in the TEE">
          {formatBps(author.feePriceBps, { decimals: 0 })}
        </Stat>
        <Stat label="You lock" hint={round ? `floor ${formatBps(round.licenseFeeMinBps, { decimals: 0 })}` : undefined}>
          {formatBps(lock, { decimals: 0 })}
        </Stat>
        <Stat label="Licenses">
          {author.licenseCount === null ? "--" : `${formatInt(author.licenseCount)}/${MAX_LICENSES_PER_AUTHOR}`}
        </Stat>
        <Stat label="Strategy">{author.strategyVersion ? `v${author.strategyVersion}, sealed` : "sealed"}</Stat>
      </div>
      {lock !== null ? (
        <p className="px-3 pb-3 text-xs text-fg-dim">
          At {formatBps(lock, { decimals: 0 })}, every {formatUsd(1000)} of notional your book trades accrues {formatUsd(lock / 10)} to {author.name}, paid when the round settles. The code stays readable
          only by {author.name}.
        </p>
      ) : null}
      {local ? (
        <LocalBackForm author={author} round={round} block={block} back={back} lock={lock} />
      ) : info.cluster === "devnet" ? (
        <WalletBackFlow info={info} round={round} author={author} block={block} lock={lock} markets={markets} />
      ) : (
        <p className="border-t border-edge px-3 py-3 text-xs text-fg-dim">
          Backing on a local round runs through the local server, which only answers pages served from localhost. Open this page from the machine running the round.
        </p>
      )}
    </Panel>
  );
}
