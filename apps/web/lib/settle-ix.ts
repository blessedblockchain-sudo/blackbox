/**
 * Browser builders for closing a round out.
 *
 * Every instruction here takes a bare `Signer` on chain — no admin, no keeper.
 * That is the point: when a round's clock runs out, any wallet can walk it
 * through settlement, and the /arena panel lets a visitor be that wallet.
 *
 * Order matters, and mirrors `scripts/run-round.ts`:
 *   tick_clock*  ->  settle_license*  ->  settle_entrant*  ->  undelegate_entrant*
 *   ->  rank_round  ->  pay_prizes  ->  close_round   (all on the rollup)
 *   ->  init_hall / record_hall                        (on L1, after the commit)
 *
 * Losers settle before winners so profits come out of their losses rather than
 * the house bankroll, same as the runner.
 */
import { ComputeBudgetProgram, PublicKey, TransactionInstruction, type AccountMeta } from "@solana/web3.js";
import { buildIx } from "./license-ix";
import { entrantPda, hallPda, marketPda, positionPda, scoreboardPda, strategyPda } from "./chain";
import { ata, permissionPda } from "./espl";

const cu = (units: number) => ComputeBudgetProgram.setComputeUnitLimit({ units });
const markets = (round: PublicKey, n: number): AccountMeta[] =>
  Array.from({ length: n }, (_, i) => ({ pubkey: marketPda(round, i), isSigner: false, isWritable: true }));

/** ER: advance the round clock one tick. Permissionless, and bounded by wall time on chain. */
export function tickClockIx(round: PublicKey): TransactionInstruction {
  return buildIx("tick_clock", {}, { round });
}

/** ER: close an entrant's book, pay their PnL, and scrub the private bodies. */
export function settleEntrantIxs(round: PublicKey, mint: PublicKey, owner: PublicKey, nMarkets: number, payer: PublicKey): TransactionInstruction[] {
  const entrant = entrantPda(round, owner);
  const strategy = strategyPda(round, owner);
  const position = positionPda(round, owner);
  return [
    cu(800_000),
    buildIx(
      "settle_entrant",
      {},
      {
        payer,
        round,
        scoreboard: scoreboardPda(round),
        entrant,
        strategy,
        position,
        owner_ata: ata(mint, owner),
        custody_ata: ata(mint, entrant),
        vault_ata: ata(mint, round),
        strategy_permission: permissionPda(strategy),
        position_permission: permissionPda(position),
      },
      markets(round, nMarkets),
    ),
  ];
}

/** ER: send a settled entrant's accounts back to L1. */
export function undelegateEntrantIx(round: PublicKey, owner: PublicKey, payer: PublicKey): TransactionInstruction {
  return buildIx("undelegate_entrant", {}, { payer, round, entrant: entrantPda(round, owner), strategy: strategyPda(round, owner), position: positionPda(round, owner) });
}

/** ER: fill in final ranks on the scoreboard. */
export function rankRoundIx(round: PublicKey, payer: PublicKey): TransactionInstruction {
  return buildIx("rank_round", {}, { payer, round, scoreboard: scoreboardPda(round) });
}

/** ER: pay the pot to the top three. `winners` must be rank order, best first. */
export function payPrizesIxs(round: PublicKey, mint: PublicKey, winners: PublicKey[], payer: PublicKey): TransactionInstruction[] {
  const remaining: AccountMeta[] = winners.slice(0, 3).flatMap((w) => [
    { pubkey: entrantPda(round, w), isSigner: false, isWritable: true },
    { pubkey: ata(mint, w), isSigner: false, isWritable: true },
  ]);
  return [cu(400_000), buildIx("pay_prizes", {}, { payer, round, scoreboard: scoreboardPda(round), vault_ata: ata(mint, round) }, remaining)];
}

/** ER: the last instruction of a round — commits the round and scoreboard back to L1. */
export function closeRoundIxs(round: PublicKey, nMarkets: number, payer: PublicKey): TransactionInstruction[] {
  return [cu(400_000), buildIx("close_round", {}, { payer, round, scoreboard: scoreboardPda(round) }, markets(round, nMarkets))];
}

/** L1, after the round has committed: write a wallet's result into its Hall record. */
export function recordHallIxs(round: PublicKey, wallet: PublicKey, payer: PublicKey): TransactionInstruction[] {
  const hall = hallPda(wallet);
  return [
    buildIx("init_hall", {}, { hall, wallet, payer }),
    buildIx("record_hall", {}, { round, scoreboard: scoreboardPda(round), hall, entrant: entrantPda(round, wallet) }),
  ];
}
