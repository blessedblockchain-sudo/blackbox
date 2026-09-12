import { expect } from "chai";
import { Program, type Provider } from "@coral-xyz/anchor";
import { Connection, Keypair, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import { IDL, chatPda, entrantPda, hallPda, licenceMark, licencesFromChat, marketPda, positionPda, scoreboardPda, strategyPda, type ChatMessage } from "../lib/chain";
import { EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID, TOKEN_PROGRAM_ID, ata, permissionPda } from "../lib/espl";
import { announceLicenceIx } from "../lib/license-ix";
import { closeRoundIxs, payPrizesIxs, rankRoundIx, recordHallIxs, settleEntrantIxs, tickClockIx, undelegateEntrantIx } from "../lib/settle-ix";

const MAGIC_CONTEXT_ID = "MagicContext1111111111111111111111111111111";

const program = new Program(IDL, { connection: new Connection("http://127.0.0.1:1") } as unknown as Provider);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const methods = program.methods as any;

const flat = (ix: TransactionInstruction) => ({
  program: ix.programId.toBase58(),
  keys: ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]),
  data: Buffer.from(ix.data).toString("hex"),
});

const markets = (round: ReturnType<typeof Keypair.generate>["publicKey"], n: number) =>
  Array.from({ length: n }, (_, i) => ({ pubkey: marketPda(round, i), isSigner: false, isWritable: true }));

describe("settle-ix: the close-out path a visitor can run", () => {
  const round = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const owner = Keypair.generate().publicKey;
  const payer = Keypair.generate().publicKey;
  const n = 3;

  it("tick_clock", async () => {
    const expected = await methods.tickClock().accountsPartial({ round }).instruction();
    expect(flat(tickClockIx(round))).to.deep.equal(flat(expected));
  });

  it("settle_entrant", async () => {
    const entrant = entrantPda(round, owner);
    const strategy = strategyPda(round, owner);
    const position = positionPda(round, owner);
    const expected = await methods
      .settleEntrant()
      .accountsPartial({
        payer,
        round,
        scoreboard: scoreboardPda(round),
        entrant,
        strategy,
        position,
        ownerAta: ata(mint, owner),
        custodyAta: ata(mint, entrant),
        vaultAta: ata(mint, round),
        strategyPermission: permissionPda(strategy),
        positionPermission: permissionPda(position),
        permissionProgram: PERMISSION_PROGRAM_ID,
        ephemeralVault: EPHEMERAL_VAULT_ID,
        magicProgram: MAGIC_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts(markets(round, n))
      .instruction();
    const ixs = settleEntrantIxs(round, mint, owner, n, payer);
    expect(ixs).to.have.length(2);
    expect(flat(ixs[1])).to.deep.equal(flat(expected));
  });

  it("undelegate_entrant", async () => {
    const expected = await methods
      .undelegateEntrant()
      .accountsPartial({ payer, round, entrant: entrantPda(round, owner), strategy: strategyPda(round, owner), position: positionPda(round, owner), magicProgram: MAGIC_PROGRAM_ID, magicContext: MAGIC_CONTEXT_ID })
      .instruction();
    expect(flat(undelegateEntrantIx(round, owner, payer))).to.deep.equal(flat(expected));
  });

  it("rank_round", async () => {
    const expected = await methods.rankRound().accountsPartial({ payer, round, scoreboard: scoreboardPda(round) }).instruction();
    expect(flat(rankRoundIx(round, payer))).to.deep.equal(flat(expected));
  });

  it("pay_prizes, with the winners in rank order", async () => {
    const winners = [Keypair.generate().publicKey, Keypair.generate().publicKey, Keypair.generate().publicKey];
    const expected = await methods
      .payPrizes()
      .accountsPartial({ payer, round, scoreboard: scoreboardPda(round), vaultAta: ata(mint, round), tokenProgram: TOKEN_PROGRAM_ID })
      .remainingAccounts(winners.flatMap((w) => [
        { pubkey: entrantPda(round, w), isSigner: false, isWritable: true },
        { pubkey: ata(mint, w), isSigner: false, isWritable: true },
      ]))
      .instruction();
    const ixs = payPrizesIxs(round, mint, winners, payer);
    expect(flat(ixs[1])).to.deep.equal(flat(expected));
  });

  it("pay_prizes takes at most three winners", () => {
    const five = Array.from({ length: 5 }, () => Keypair.generate().publicKey);
    expect(payPrizesIxs(round, mint, five, payer)[1].keys).to.have.length(5 + 6);
  });

  it("close_round", async () => {
    const expected = await methods
      .closeRound()
      .accountsPartial({ payer, round, scoreboard: scoreboardPda(round), magicProgram: MAGIC_PROGRAM_ID, magicContext: MAGIC_CONTEXT_ID })
      .remainingAccounts(markets(round, n))
      .instruction();
    const ixs = closeRoundIxs(round, n, payer);
    expect(ixs).to.have.length(2);
    expect(flat(ixs[1])).to.deep.equal(flat(expected));
  });

  it("init_hall + record_hall", async () => {
    const hall = hallPda(owner);
    const init = await methods.initHall().accountsPartial({ hall, wallet: owner, payer, systemProgram: SystemProgram.programId }).instruction();
    const rec = await methods.recordHall().accountsPartial({ round, scoreboard: scoreboardPda(round), hall, entrant: entrantPda(round, owner) }).instruction();
    const ixs = recordHallIxs(round, owner, payer);
    expect(ixs).to.have.length(2);
    expect(flat(ixs[0])).to.deep.equal(flat(init));
    expect(flat(ixs[1])).to.deep.equal(flat(rec));
  });
});

describe("the public licence registry", () => {
  const round = Keypair.generate().publicKey;
  const buyer = Keypair.generate().publicKey;
  const author = Keypair.generate().publicKey;

  it("announce_licence posts the author's key as chat text", async () => {
    const expected = await methods
      .postChat(licenceMark(author.toBase58()))
      .accountsPartial({ author: buyer, round, chat: chatPda(round), vault: EPHEMERAL_VAULT_ID, magicProgram: MAGIC_PROGRAM_ID })
      .instruction();
    expect(flat(announceLicenceIx(round, buyer, author))).to.deep.equal(flat(expected));
  });

  it("fits the 79-byte chat limit", () => {
    expect(Buffer.byteLength(licenceMark(author.toBase58()), "utf8")).to.be.at.most(79);
  });

  it("reads (buyer, author) back out of the chat", () => {
    const msg = (a: string, text: string): ChatMessage => ({ author: a, tick: 1, ts: 0, text });
    const rows = licencesFromChat([
      msg(buyer.toBase58(), "gm"),
      msg(buyer.toBase58(), licenceMark(author.toBase58())),
      msg(buyer.toBase58(), licenceMark(author.toBase58())),
      msg(buyer.toBase58(), "licensed:not-a-pubkey"),
    ]);
    expect(rows).to.deep.equal([{ buyer: buyer.toBase58(), author: author.toBase58() }]);
  });
});
