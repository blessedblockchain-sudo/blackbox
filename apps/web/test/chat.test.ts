import { expect } from "chai";
import { Keypair } from "@solana/web3.js";
import { decodeChat as sdkDecodeChat } from "@blackbox/sdk/src/client";
import { CHAT_HEADER, CHAT_SLOTS, CHAT_SLOT_SIZE, chatTextError, decodeChat } from "../lib/chain";
import { formatMs } from "../lib/format";
import { formatSol } from "../lib/amount";

/** Write messages the way post_chat does (programs/blackbox/src/instructions/chat.rs). */
function chatAccount(posts: { author: Keypair; tick: number; ts: number; text: string }[]): Buffer {
  const d = Buffer.alloc(CHAT_HEADER + CHAT_SLOTS * CHAT_SLOT_SIZE);
  for (const p of posts) {
    const head = d.readUInt32LE(0) % CHAT_SLOTS;
    const count = d.readUInt32LE(4);
    const off = CHAT_HEADER + head * CHAT_SLOT_SIZE;
    d.fill(0, off, off + CHAT_SLOT_SIZE);
    p.author.publicKey.toBuffer().copy(d, off);
    d.writeBigUInt64LE(BigInt(p.tick), off + 32);
    d.writeBigInt64LE(BigInt(p.ts), off + 40);
    const bytes = Buffer.from(p.text, "utf8");
    d[off + 48] = bytes.length;
    bytes.copy(d, off + 49);
    d.writeUInt32LE((head + 1) % CHAT_SLOTS, 0);
    d.writeUInt32LE(count + 1, 4);
  }
  return d;
}

describe("chat: round chat ring buffer", () => {
  const a = Keypair.generate();
  const b = Keypair.generate();

  it("decodes messages oldest first, like the SDK", () => {
    const posts = [
      { author: a, tick: 10, ts: 1_789_000_000, text: "gm arena" },
      { author: b, tick: 12, ts: 1_789_000_001, text: "sealed and shipping" },
      { author: a, tick: 15, ts: 1_789_000_003, text: "unicode ok: ±5 bps" },
    ];
    const data = chatAccount(posts);
    const mine = decodeChat(data);
    expect(mine.map((m) => m.text)).to.deep.equal(posts.map((p) => p.text));
    expect(mine[1]).to.deep.equal({ author: b.publicKey.toBase58(), tick: 12, ts: 1_789_000_001, text: "sealed and shipping" });
    const sdk = sdkDecodeChat(data).map((m) => ({ ...m, author: m.author.toBase58() }));
    expect(mine).to.deep.equal(sdk);
  });

  it("keeps the last 32 after the ring wraps", () => {
    const posts = Array.from({ length: 40 }, (_, i) => ({ author: i % 2 ? a : b, tick: i, ts: 1_789_000_000 + i, text: `message ${i}` }));
    const mine = decodeChat(chatAccount(posts));
    expect(mine).to.have.length(32);
    expect(mine[0].text).to.equal("message 8");
    expect(mine[31].text).to.equal("message 39");
    expect(decodeChat(new Uint8Array(100))).to.deep.equal([]);
  });

  it("applies post_chat's text rule", () => {
    expect(chatTextError("gm")).to.equal(null);
    expect(chatTextError("x".repeat(79))).to.equal(null);
    expect(chatTextError("x".repeat(80))).to.match(/at most 79 bytes/);
    expect(chatTextError("é".repeat(40))).to.match(/this one is 80/);
    expect(chatTextError("")).to.match(/Write a message/);
    expect(chatTextError("line\nbreak")).to.match(/Control characters/);
    expect(chatTextError("del\x7f")).to.match(/Control characters/);
  });
});

describe("format: elapsed times and SOL", () => {
  it("formats milliseconds", () => {
    expect(formatMs(363)).to.equal("363 ms");
    expect(formatMs(1_234)).to.equal("1.2 s");
    expect(formatMs(59_999)).to.equal("59.9 s");
    expect(formatMs(65_000)).to.equal("1m 05s");
    expect(formatMs(null)).to.equal("--");
  });
  it("formats SOL balances", () => {
    expect(formatSol(1.979996632)).to.equal("1.98");
    expect(formatSol(0.00213)).to.equal("0.0021");
    expect(formatSol(2)).to.equal("2");
    expect(formatSol(null)).to.equal("--");
  });
});
