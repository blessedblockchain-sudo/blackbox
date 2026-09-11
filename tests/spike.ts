/**
 * BLACKBOX Phase 0 verification matrix.
 *
 * Runs the `spike` program end to end against either the local mb-stack
 * (base 8899 / ER 7799 / TEE-emulating QFS 6699) or devnet + devnet-tee, and
 * prints a PASS/FAIL table for every integration bet the real program relies on.
 *
 * Env:
 *   PROVIDER_ENDPOINT / WS_ENDPOINT              base layer
 *   TEE_PROVIDER_ENDPOINT / TEE_WS_ENDPOINT      TEE (or local QFS) endpoint
 *   EPHEMERAL_PROVIDER_ENDPOINT                  plain ER endpoint (optional, for the "non-TEE read" attack)
 *   VALIDATOR                                    validator identity to delegate to
 *   ORACLE_FEED                                  Pyth Lazer price account (devnet); omit to use the mock feed
 *   SKIP_VRF=1                                   skip the VRF check
 */
import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  Connection,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createInitializeMintInstruction,
  createMintToInstruction,
  getAccount,
  getMinimumBalanceForRentExemptMint,
  MINT_SIZE,
} from "@solana/spl-token";
import {
  GetCommitmentSignature,
  getAuthToken,
  verifyTeeRpcIntegrity,
  permissionPdaFromAccount,
  delegateSpl,
  deriveEphemeralAta,
  deriveRentPda,
  delegationRecordPdaFromDelegatedAccount,
  delegationMetadataPdaFromDelegatedAccount,
  MAGIC_PROGRAM_ID,
  PERMISSION_PROGRAM_ID,
  EPHEMERAL_VAULT_ID,
  EPHEMERAL_SPL_TOKEN_PROGRAM_ID,
  DELEGATION_PROGRAM_ID,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import * as nacl from "tweetnacl";
import idl from "../target/idl/spike.json";
import type { Spike } from "../target/types/spike";

const VAULT_SEED = "vault";
const NOTE_SEED = "note";
const MOCK_SEED = "mock";
const ORACLE_PROGRAM_ID = new PublicKey("PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd");
const VRF_BASE_QUEUE = new PublicKey("Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh");
const VRF_EPHEMERAL_QUEUE = new PublicKey("5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc");
const VRF_TEST_QUEUE = new PublicKey("GKE6d7iv8kCBrsxr78W3xVdjGLLLJnxsGiuzrsZCGEvb");
const VRF_EPHEMERAL_TEST_QUEUE = new PublicKey("Sc9MJUngNbQXSXGP3F67KvKwVnhaYn6kcioxXNVowYT");

type Check = { name: string; status: "PASS" | "FAIL" | "SKIP"; detail: string };
const results: Check[] = [];
function record(name: string, ok: boolean | null, detail = "") {
  const status = ok === null ? "SKIP" : ok ? "PASS" : "FAIL";
  results.push({ name, status, detail });
  console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function tryRead(conn: Connection, key: PublicKey): Promise<{ ok: boolean; bytes: number; err?: string }> {
  try {
    const info = await conn.getAccountInfo(key, "processed");
    if (!info) return { ok: false, bytes: 0, err: "null" };
    return { ok: true, bytes: info.data.length };
  } catch (e: any) {
    return { ok: false, bytes: 0, err: String(e?.message ?? e).slice(0, 120) };
  }
}

function isZeroed(data: Buffer, from: number, len: number) {
  for (let i = from; i < from + len; i++) if (data[i] !== 0) return false;
  return true;
}

describe("BLACKBOX spike: MagicBlock integration matrix", function () {
  this.timeout(600_000);

  const baseUrl = process.env.PROVIDER_ENDPOINT || "https://api.devnet.solana.com";
  const baseWs = process.env.WS_ENDPOINT || undefined;
  const teeUrl = (process.env.TEE_PROVIDER_ENDPOINT || "https://devnet-tee.magicblock.app").replace(/\/$/, "");
  const teeWs = (process.env.TEE_WS_ENDPOINT || "wss://devnet-tee.magicblock.app").replace(/\/$/, "");
  const plainErUrl = process.env.EPHEMERAL_PROVIDER_ENDPOINT || "";
  const isLocal = teeUrl.includes("localhost") || teeUrl.includes("127.0.0.1");
  const validator = new PublicKey(
    process.env.VALIDATOR ||
      (isLocal ? "mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev" : "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo"),
  );
  const oracleFeed = process.env.ORACLE_FEED ? new PublicKey(process.env.ORACLE_FEED) : null;

  const wallet = anchor.Wallet.local();
  const payer = wallet.payer;
  const provider = new anchor.AnchorProvider(
    new Connection(baseUrl, { wsEndpoint: baseWs, commitment: "confirmed" }),
    wallet,
  );
  anchor.setProvider(provider);
  const program = new Program<Spike>(idl as Spike, provider);

  // filled in `before`
  let teeToken = "";
  let teeProvider: anchor.AnchorProvider;
  let teeProgram: Program<Spike>;
  let teeConnNoToken: Connection;
  let strangerToken = "";
  let strangerConn: Connection;
  const stranger = Keypair.generate();

  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from(VAULT_SEED), payer.publicKey.toBuffer()],
    program.programId,
  );
  const [mockPda] = PublicKey.findProgramAddressSync(
    [Buffer.from(MOCK_SEED), payer.publicKey.toBuffer()],
    program.programId,
  );
  const [notePda] = PublicKey.findProgramAddressSync(
    [Buffer.from(NOTE_SEED), vaultPda.toBuffer()],
    program.programId,
  );
  const vaultPermission = permissionPdaFromAccount(vaultPda);
  const notePermission = permissionPdaFromAccount(notePda);

  let hotSwapSig = "";
  const SECRET = Buffer.alloc(32, 0xab);
  // token flow state (created before delegation, used on the ER later)
  const mint = Keypair.generate();
  const user = Keypair.generate();
  let userAta: PublicKey;
  let vaultAta: PublicKey;

  async function sendTee(tx: Transaction, signers: Keypair[] = []) {
    tx.feePayer = payer.publicKey;
    tx.recentBlockhash = (await teeProvider.connection.getLatestBlockhash()).blockhash;
    tx.sign(payer, ...signers);
    const sig = await teeProvider.connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    const conf = await teeProvider.connection.confirmTransaction(sig, "confirmed");
    if (conf.value.err) throw new Error(`ER tx failed ${sig}: ${JSON.stringify(conf.value.err)}`);
    return sig;
  }

  async function sendBase(tx: Transaction, signers: Keypair[] = []) {
    const { sendAndConfirmTransaction } = await import("@solana/web3.js");
    for (let attempt = 0; ; attempt++) {
    try {
      return await sendAndConfirmTransaction(provider.connection, tx, [payer, ...signers], { commitment: "confirmed", skipPreflight: false });
    } catch (e: any) {
      if (attempt < 2 && String(e?.message ?? e).includes("Blockhash not found")) { await sleep(1500); continue; }
      const logs = e?.logs ?? (typeof e?.getLogs === "function" ? await e.getLogs(provider.connection).catch(() => null) : null);
      throw new Error(`base tx failed: ${e?.message ?? e}\n${(logs ?? []).join("\n")}`);
    }
    }
  }

  before(async () => {
    console.log("base:", baseUrl, "| tee:", teeUrl, "| validator:", validator.toBase58());
    console.log("wallet:", payer.publicKey.toBase58(), "program:", program.programId.toBase58());
    console.log("vault:", vaultPda.toBase58(), "note:", notePda.toBase58());
    const bal = await provider.connection.getBalance(payer.publicKey);
    console.log("balance:", bal / LAMPORTS_PER_SOL, "SOL");
    if (isLocal && bal < 5 * LAMPORTS_PER_SOL) {
      const sig = await provider.connection.requestAirdrop(payer.publicKey, 100 * LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig, "confirmed");
    }

    if (!isLocal) {
      let attErr = "";
      let attOk = false;
      for (let i = 0; i < 3 && !attOk; i++) {
        try { await verifyTeeRpcIntegrity(teeUrl); attOk = true; } catch (e: any) { attErr = String(e?.message ?? e).slice(0, 120); await sleep(2000); }
      }
      record("TEE attestation verified (verifyTeeRpcIntegrity)", attOk, attOk ? "TDX quote verified via PCCS" : attErr);
    } else {
      record("TEE attestation verified (verifyTeeRpcIntegrity)", null, "local QFS has no attestation");
    }

    const tok = await getAuthToken(teeUrl, payer.publicKey, (m: Uint8Array) =>
      Promise.resolve(nacl.sign.detached(m, payer.secretKey)),
    );
    teeToken = tok.token;
    teeProvider = new anchor.AnchorProvider(
      new Connection(`${teeUrl}?token=${teeToken}`, { wsEndpoint: `${teeWs}?token=${teeToken}`, commitment: "confirmed" }),
      wallet,
    );
    teeProgram = new Program<Spike>(idl as Spike, teeProvider);
    teeConnNoToken = new Connection(teeUrl, { commitment: "confirmed" });
    const stok = await getAuthToken(teeUrl, stranger.publicKey, (m: Uint8Array) =>
      Promise.resolve(nacl.sign.detached(m, stranger.secretKey)),
    );
    strangerToken = stok.token;
    strangerConn = new Connection(`${teeUrl}?token=${strangerToken}`, { commitment: "confirmed" });
    console.log(`TEE explorer: https://explorer.solana.com/?cluster=custom&customUrl=${encodeURIComponent(`${teeUrl}?token=${teeToken}`)}`);
    record("TEE auth token issued", teeToken.length > 0);
  });

  it("1. initialize vault + mock feed on L1", async () => {
    const vInfo = await provider.connection.getAccountInfo(vaultPda);
    const mInfo = await provider.connection.getAccountInfo(mockPda);
    const tx = new Transaction();
    if (!vInfo) tx.add(await program.methods.initialize(new BN(0.05 * LAMPORTS_PER_SOL)).accounts({ authority: payer.publicKey }).instruction());
    if (!mInfo) tx.add(await program.methods.initMock(new BN(150_000_000), -6).accounts({ authority: payer.publicKey }).instruction());
    const sig = tx.instructions.length ? await sendBase(tx) : "(already exists)";
    const v = await provider.connection.getAccountInfo(vaultPda);
    record("vault initialized on L1", !!v, `${sig.slice(0, 16)} owner=${v?.owner.toBase58().slice(0, 8)}`);
  });

  it("1b. token setup on L1 before delegation: mint, user ATA, vault ATA + eATA delegated", async () => {
    const [rentPda] = deriveRentPda();
    userAta = getAssociatedTokenAddressSync(mint.publicKey, user.publicKey);
    vaultAta = getAssociatedTokenAddressSync(mint.publicKey, vaultPda, true);
    const fund = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: user.publicKey, lamports: 0.2 * LAMPORTS_PER_SOL }),
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: rentPda, lamports: 0.1 * LAMPORTS_PER_SOL }),
      SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey, space: MINT_SIZE, lamports: await getMinimumBalanceForRentExemptMint(provider.connection), programId: TOKEN_PROGRAM_ID }),
      createInitializeMintInstruction(mint.publicKey, 6, payer.publicKey, null),
      createAssociatedTokenAccountInstruction(payer.publicKey, userAta, user.publicKey, mint.publicKey),
      createMintToInstruction(mint.publicKey, userAta, payer.publicKey, 1_000_000_000),
    );
    await sendBase(fund, [mint]);
    const vInfo = await provider.connection.getAccountInfo(vaultPda);
    if (!vInfo || !vInfo.owner.equals(program.programId)) {
      record("vault ATA + eATA initialized and delegated (program CPI)", null, "vault already delegated; token custody setup must precede delegation");
      return;
    }
    const [vaultEata] = deriveEphemeralAta(vaultPda, mint.publicKey);
    const [eataBuffer] = PublicKey.findProgramAddressSync([Buffer.from("buffer"), vaultEata.toBuffer()], EPHEMERAL_SPL_TOKEN_PROGRAM_ID);
    const eataRecord = delegationRecordPdaFromDelegatedAccount(vaultEata);
    const eataMetadata = delegationMetadataPdaFromDelegatedAccount(vaultEata);
    const s1 = await sendBase(
      new Transaction().add(
        await program.methods
          .initVaultToken()
          .accountsPartial({ authority: payer.publicKey, vault: vaultPda, mint: mint.publicKey, vaultAta, vaultEata, eataBuffer, eataRecord, eataMetadata, ephemeralTokenProgram: EPHEMERAL_SPL_TOKEN_PROGRAM_ID, delegationProgram: DELEGATION_PROGRAM_ID, validator })
          .instruction(),
      ),
    );
    record("vault ATA + eATA initialized and delegated (program CPI)", true, s1.slice(0, 16));
  });

  it("2. delegate vault (+mock) to the validator with commit_frequency_ms = MAX", async () => {
    const vInfo = await provider.connection.getAccountInfo(vaultPda);
    const mInfo = await provider.connection.getAccountInfo(mockPda);
    const tx = new Transaction();
    if (vInfo && vInfo.owner.equals(program.programId)) tx.add(await program.methods.delegate().accountsPartial({ authority: payer.publicKey, vault: vaultPda, validator }).instruction());
    if (mInfo && mInfo.owner.equals(program.programId)) tx.add(await program.methods.delegateMock().accountsPartial({ authority: payer.publicKey, mock: mockPda, validator }).instruction());
    const sig = tx.instructions.length ? await sendBase(tx) : "(already delegated)";
    await sleep(3000);
    const info = await provider.connection.getAccountInfo(vaultPda);
    record("vault owned by delegation program on L1", !!info && info.owner.equals(DELEGATION_PROGRAM_ID), sig.slice(0, 16));
    let ok = false;
    for (let i = 0; i < 40 && !ok; i++) {
      const r = await tryRead(teeProvider.connection, vaultPda);
      ok = r.ok;
      if (!ok) await sleep(500);
    }
    record("vault visible on ER (owner token)", ok);
  });

  it("3. init permission + set private on the ER", async () => {
    const common = {
      authority: payer.publicKey,
      vault: vaultPda,
      permission: vaultPermission,
      permissionProgram: PERMISSION_PROGRAM_ID,
      ephemeralVault: EPHEMERAL_VAULT_ID,
      magicProgram: MAGIC_PROGRAM_ID,
    };
    const s1 = await sendTee(new Transaction().add(await teeProgram.methods.initPermission().accountsPartial(common).instruction()));
    const s2 = await sendTee(new Transaction().add(await teeProgram.methods.setPrivacy(true).accountsPartial(common).instruction()));
    await sleep(1500);
    record("permission created + private", true, `${s1.slice(0, 12)} ${s2.slice(0, 12)}`);
  });

  it("4. attacker matrix on the private vault", async () => {
    const owner = await tryRead(teeProvider.connection, vaultPda);
    record("owner token CAN read private vault", owner.ok, `${owner.bytes} bytes`);
    const noTok = await tryRead(teeConnNoToken, vaultPda);
    record("no token CANNOT read private vault", !noTok.ok, noTok.err ?? `${noTok.bytes} bytes`);
    const strg = await tryRead(strangerConn, vaultPda);
    record("stranger token CANNOT read private vault", !strg.ok, strg.err ?? `${strg.bytes} bytes`);
  });

  it("5. write secret via ER tx; check tx message privacy and L1 zeros", async () => {
    hotSwapSig = await sendTee(
      new Transaction().add(
        await teeProgram.methods.writeSecret([...SECRET]).accountsPartial({ authority: payer.publicKey, vault: vaultPda }).instruction(),
      ),
    );
    const v = await teeProgram.account.vault.fetch(vaultPda);
    record("owner reads secret back on ER", Buffer.from(v.secret).equals(SECRET), hotSwapSig.slice(0, 16));
    // L1 copy must still be zero (no auto-commit)
    const l1 = await provider.connection.getAccountInfo(vaultPda);
    const off = 8 + 32 + 1 + 8 + 8 + 4 + 8 + 1; // secret offset in Vault
    record("L1 copy of vault has zeroed secret (no timer commit)", !!l1 && isZeroed(l1.data, off, 32));
    // getTransaction visibility
    const asOwner = await teeProvider.connection.getTransaction(hotSwapSig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    record("owner can fetch the secret-writing tx", !!asOwner);
    let strangerTx: any = null, strangerErr = "";
    try {
      strangerTx = await strangerConn.getTransaction(hotSwapSig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    } catch (e: any) { strangerErr = String(e?.message ?? e).slice(0, 100); }
    const leaked = strangerTx && JSON.stringify(strangerTx).includes(Buffer.from(SECRET).toString("base64").slice(0, 10));
    record("stranger cannot see the tx message (TX_MESSAGE_FLAG)", !strangerTx || !leaked, strangerTx ? "tx returned; message " + (leaked ? "LEAKED" : "hidden") : strangerErr || "null");
    if (plainErUrl) {
      try {
        const info = await new Connection(plainErUrl, "confirmed").getAccountInfo(vaultPda, "processed");
        const leak = !!info && info.data.includes(SECRET);
        record("plain (non-TEE) ER RPC never sees the secret", !leak, info ? `returned ${info.data.length} bytes (stale L1 copy), secret ${leak ? "LEAKED" : "absent"}` : "null");
      } catch (e: any) {
        record("plain (non-TEE) ER RPC never sees the secret", true, "read failed: " + String(e?.message ?? e).slice(0, 60));
      }
    }
  });

  it("6. Native Crank tick reads the price feed and mutates the private vault", async () => {
    const feed = oracleFeed ?? mockPda;
    if (!oracleFeed) {
      // make sure the mock is delegated & readable on ER, and set a fresh price on the ER
      await sendTee(new Transaction().add(await teeProgram.methods.setMockPrice(new BN(151_250_000), -6).accountsPartial({ authority: payer.publicKey, mock: mockPda }).instruction()));
    } else {
      const fi = await teeProvider.connection.getAccountInfo(feed);
      record("oracle feed account readable on the TEE ER", !!fi && fi.owner.equals(ORACLE_PROGRAM_ID), fi ? `${fi.data.length} bytes` : "null");
    }
    const before = await teeProgram.account.vault.fetch(vaultPda);
    const stamps: number[] = [];
    let lastCount = before.count.toNumber();
    const sig = await sendTee(
      new Transaction().add(
        await teeProgram.methods
          .scheduleTick(new BN(Date.now() % 1_000_000), new BN(1000), new BN(5))
          .accountsPartial({ magicProgram: MAGIC_PROGRAM_ID, payer: payer.publicKey, vault: vaultPda, priceUpdate: feed, program: program.programId })
          .instruction(),
      ),
    );
    let after = before;
    const t0 = Date.now();
    while (Date.now() - t0 < 12_000) {
      after = await teeProgram.account.vault.fetch(vaultPda);
      if (after.count.toNumber() !== lastCount) { stamps.push(Date.now() - t0); lastCount = after.count.toNumber(); }
      if (after.count.toNumber() >= before.count.toNumber() + 5) break;
      await sleep(100);
    }
    const ticks = after.count.toNumber() - before.count.toNumber();
    record("crank ticks executed on the TEE ER", ticks >= 3, `${ticks} ticks, observed at +${stamps.join("ms, +")}ms (interval 1000ms) (${sig.slice(0, 12)})`);
    record("tick read a price", after.lastPrice.toNumber() > 0, `price=${after.lastPrice.toString()}e${after.lastExpo} src=${after.lastSource === 1 ? "oracle" : "mock"}`);
  });

  it("7. Ephemeral SPL: user delegates, transfers to vault custody on the ER, PDA-signed payout", async () => {
    const ixs = await delegateSpl(user.publicKey, mint.publicKey, 100_000_000n, { validator, idempotent: false, payer: payer.publicKey, initVaultIfMissing: true });
    await sendBase(new Transaction().add(...ixs), [user]);
    // The TEE only shows a token account to its owner: read the user's balance with the user's own token.
    const utok = await getAuthToken(teeUrl, user.publicKey, (m: Uint8Array) => Promise.resolve(nacl.sign.detached(m, user.secretKey)));
    const teeUser = new Connection(`${teeUrl}?token=${utok.token}`, { commitment: "confirmed" });
    const userBal = async () => { try { return (await getAccount(teeUser, userAta)).amount; } catch { return -1n; } };
    let seen = false;
    for (let i = 0; i < 60 && !seen; i++) { seen = (await userBal()) === 100_000_000n; if (!seen) await sleep(500); }
    record("user's delegated tokens visible at ATA address on the TEE ER (owner token)", seen);
    const payerSees = await tryRead(teeProvider.connection, userAta);
    record("TEE hides the user's token account from other wallets", !payerSees.ok, payerSees.err ?? `${payerSees.bytes} bytes`);
    const { createTransferInstruction } = await import("@solana/spl-token");
    const s2 = await sendTee(new Transaction().add(createTransferInstruction(userAta, vaultAta, user.publicKey, 40_000_000)), [user]);
    let after = -1n;
    for (let i = 0; i < 20; i++) { after = await userBal(); if (after === 60_000_000n) break; await sleep(300); }
    record("user -> vault SPL transfer on the ER", after === 60_000_000n, `user=${after} (${s2.slice(0, 12)})`);
    const s3 = await sendTee(
      new Transaction().add(
        await teeProgram.methods.payout(new BN(15_000_000)).accountsPartial({ authority: payer.publicKey, vault: vaultPda, vaultAta, recipientAta: userAta, tokenProgram: TOKEN_PROGRAM_ID }).instruction(),
      ),
    );
    let final = -1n;
    for (let i = 0; i < 20; i++) { final = await userBal(); if (final === 75_000_000n) break; await sleep(300); }
    record("PDA-signed payout vault -> user on the ER", final === 75_000_000n, `user=${final} (${s3.slice(0, 12)})`);
  });

  it("8. ephemeral (ER-only) account sponsored by the vault, with its own permission", async () => {
    let s1 = "";
    try {
      const existing = await teeProvider.connection.getAccountInfo(notePda, "processed");
      if (existing && existing.data.length > 0) {
        s1 = "(exists from a previous run)";
      } else {
        s1 = await sendTee(new Transaction().add(await teeProgram.methods.createNote(64, 7).accountsPartial({ authority: payer.publicKey, spikeVault: vaultPda, note: notePda, vault: EPHEMERAL_VAULT_ID, magicProgram: MAGIC_PROGRAM_ID }).instruction()));
      }
      const n = await teeProvider.connection.getAccountInfo(notePda);
      record("ephemeral account created on ER", !!n && n.data.length === 64 && n.data[0] === 7, s1.slice(0, 16));
      const l1 = await provider.connection.getAccountInfo(notePda);
      record("ephemeral account absent on L1", !l1);
    } catch (e: any) {
      record("ephemeral account created on ER", false, String(e?.message ?? e).slice(0, 140));
      return;
    }
    try {
      const s2 = await sendTee(
        new Transaction().add(
          await teeProgram.methods
            .initNotePermission()
            .accountsPartial({ authority: payer.publicKey, vault: vaultPda, note: notePda, permission: notePermission, permissionProgram: PERMISSION_PROGRAM_ID, ephemeralVault: EPHEMERAL_VAULT_ID, magicProgram: MAGIC_PROGRAM_ID })
            .instruction(),
        ),
      );
      await sleep(1500);
      const owner = await tryRead(teeProvider.connection, notePda);
      const strg = await tryRead(strangerConn, notePda);
      record("permission on ephemeral account: owner reads, stranger denied", owner.ok && !strg.ok, `owner=${owner.ok} stranger=${strg.ok} (${s2.slice(0, 12)})`);
    } catch (e: any) {
      record("permission on ephemeral account: owner reads, stranger denied", false, String(e?.message ?? e).slice(0, 140));
    }
  });

  it("9. VRF request + callback inside the ER", async () => {
    if (process.env.SKIP_VRF) { record("VRF callback lands on the ER", null, "SKIP_VRF"); return; }
    const queue = isLocal ? VRF_EPHEMERAL_TEST_QUEUE : VRF_EPHEMERAL_QUEUE;
    const before = await teeProgram.account.vault.fetch(vaultPda);
    try {
      const sig = await sendTee(
        new Transaction().add(await teeProgram.methods.requestRandom(42).accountsPartial({ payer: payer.publicKey, vault: vaultPda, oracleQueue: queue }).instruction()),
      );
      let after = before;
      const t0 = Date.now();
      while (Date.now() - t0 < 20_000) {
        after = await teeProgram.account.vault.fetch(vaultPda);
        if (after.rndCount.toNumber() > before.rndCount.toNumber()) break;
        await sleep(400);
      }
      const ok = after.rndCount.toNumber() > before.rndCount.toNumber();
      record("VRF callback lands on the ER", ok, ok ? `in ${Date.now() - t0}ms, rnd[0]=${after.randomness[0]} (${sig.slice(0, 12)})` : "no callback within 20s");
    } catch (e: any) {
      record("VRF callback lands on the ER", false, String(e?.message ?? e).slice(0, 160));
    }
  });

  it("10. close permissions + note, scrub, commit + undelegate; L1 must hold zeros", async () => {
    const noteAccs = { authority: payer.publicKey, vault: vaultPda, note: notePda, permission: notePermission, permissionProgram: PERMISSION_PROGRAM_ID, ephemeralVault: EPHEMERAL_VAULT_ID, magicProgram: MAGIC_PROGRAM_ID };
    try {
      await sendTee(new Transaction().add(await teeProgram.methods.closeNotePermission().accountsPartial(noteAccs).instruction()));
      await sendTee(new Transaction().add(await teeProgram.methods.closeNote().accountsPartial({ authority: payer.publicKey, spikeVault: vaultPda, note: notePda, vault: EPHEMERAL_VAULT_ID, magicProgram: MAGIC_PROGRAM_ID }).instruction()));
      const n = await teeProvider.connection.getAccountInfo(notePda, "processed");
      record("note permission + note closed on the ER", !n || n.data.length === 0);
    } catch (e: any) { record("note permission + note closed on the ER", false, String(e?.message ?? e).slice(0, 120)); }
    try {
      await sendTee(new Transaction().add(await teeProgram.methods.closePermission().accountsPartial({ authority: payer.publicKey, vault: vaultPda, permission: vaultPermission, permissionProgram: PERMISSION_PROGRAM_ID, ephemeralVault: EPHEMERAL_VAULT_ID, magicProgram: MAGIC_PROGRAM_ID }).instruction()));
      const pinfo = await teeProvider.connection.getAccountInfo(vaultPermission, "processed");
      record("vault permission closed on the ER", !pinfo || pinfo.data.length === 0, pinfo ? `len=${pinfo.data.length} lamports=${pinfo.lamports}` : "null");
    } catch (e: any) { record("vault permission closed on the ER", false, String(e?.message ?? e).slice(0, 120)); }
    await sendTee(new Transaction().add(await teeProgram.methods.scrub().accountsPartial({ authority: payer.publicKey, vault: vaultPda }).instruction()));
    const sig = await sendTee(new Transaction().add(await teeProgram.methods.undelegate().accountsPartial({ payer: payer.publicKey, vault: vaultPda }).instruction()));
    let l1: any = null;
    for (let i = 0; i < 60; i++) {
      l1 = await provider.connection.getAccountInfo(vaultPda);
      if (l1 && l1.owner.equals(program.programId)) break;
      await sleep(1000);
    }
    record("vault undelegated back to L1", !!l1 && l1.owner.equals(program.programId), sig.slice(0, 16));
    const off = 8 + 32 + 1 + 8 + 8 + 4 + 8 + 1;
    record("scrubbed secret is zero on L1 after commit", !!l1 && isZeroed(l1.data, off, 32));
    const v = await program.account.vault.fetch(vaultPda);
    record("tick count survived the commit", v.count.toNumber() > 0, `count=${v.count.toString()}`);
    // undelegate the mock too so re-runs start clean
    try {
      const mInfo = await provider.connection.getAccountInfo(mockPda);
      if (mInfo && mInfo.owner.equals(DELEGATION_PROGRAM_ID)) {
        await sendTee(new Transaction().add(await teeProgram.methods.undelegateMock().accountsPartial({ payer: payer.publicKey, mock: mockPda }).instruction()));
        let back = false;
        for (let i = 0; i < 30 && !back; i++) { const m = await provider.connection.getAccountInfo(mockPda); back = !!m && m.owner.equals(program.programId); if (!back) await sleep(1000); }
        record("mock feed undelegated back to L1", back);
      }
    } catch (e: any) { record("mock feed undelegated back to L1", false, String(e?.message ?? e).slice(0, 120)); }
  });

  after(async () => {
    console.log("\n==== BLACKBOX Phase 0 verification matrix ====");
    for (const r of results) console.log(`${r.status.padEnd(4)} ${r.name}${r.detail ? "  (" + r.detail + ")" : ""}`);
    const fails = results.filter((r) => r.status === "FAIL").length;
    console.log(`\n${results.length - fails - results.filter((r) => r.status === "SKIP").length} pass, ${fails} fail, ${results.filter((r) => r.status === "SKIP").length} skip`);
    setTimeout(() => process.exit(fails ? 1 : 0), 200);
  });
});
