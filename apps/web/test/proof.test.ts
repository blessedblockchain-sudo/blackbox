import { expect } from "chai";
import { accessOf, whoAsked, type MatrixRow } from "../lib/proof";

const row = (path: string, result: string, pass = true): MatrixRow => ({ path, request: "", result, expected: "", pass });

describe("proof: attacker matrix rows", () => {
  it("names who made each request", () => {
    expect(whoAsked("TEE owner token → Strategy (control)", { owner: "Momentum" })).to.equal("the owner (Momentum), with its auth token");
    expect(whoAsked("TEE no token → Position")).to.equal("anyone, no auth token");
    expect(whoAsked("TEE fresh token → Strategy")).to.equal("a brand-new wallet, with its token");
    expect(whoAsked("TEE rival token → getMultipleAccounts", { rival: "Degen" })).to.equal("a rival entrant (Degen), with its token");
    expect(whoAsked("TEE fresh token → getProgramAccounts")).to.equal("a brand-new wallet, with its token");
    expect(whoAsked("set_strategy tx → stranger getTransaction")).to.equal("a stranger's token and no token");
    expect(whoAsked("L1 getAccountInfo → Strategy")).to.equal("anyone on Solana L1");
    expect(whoAsked("L1 delegation PDAs → Position")).to.equal("anyone on Solana L1");
    expect(whoAsked("raw ER RPC (7799) → Strategy")).to.equal("a process on this machine (dev-only port)");
    expect(whoAsked("preflight: target is an entrant")).to.equal("anyone (public Entrant)");
  });

  it("classifies what came back", () => {
    expect(accessOf(row("TEE owner token → Strategy (control)", "4192 bytes readable, 40-byte program"))).to.equal("read");
    expect(accessOf(row("TEE owner token → Position (control)", "error: fetch failed", false))).to.equal("error");
    expect(accessOf(row("TEE owner token → Strategy (control)", "scrubbed (body all zero)"))).to.equal("blocked");
    expect(accessOf(row("TEE no token → Strategy", "null"))).to.equal("blocked");
    expect(accessOf(row("TEE rival token → Strategy", "LEAK: 4192 bytes", false))).to.equal("read");
    expect(accessOf(row("TEE fresh token → Position", "inconclusive (rpc error): socket hang up", false))).to.equal("error");
    expect(accessOf(row("set_strategy tx → stranger getTransaction", "redacted: 0 instr, 0 bytes of data"))).to.equal("blocked");
    expect(accessOf(row("L1 getAccountInfo → Strategy", "owner=delegation program, region[96..]=all zero"))).to.equal("blocked");
    expect(accessOf(row("preflight: target is an entrant", "entrant #0 (TEE), strategy v1"))).to.equal("info");
    expect(accessOf(row("raw ER RPC (7799) → Strategy", "4192 bytes (internal port, not exposed in production)"))).to.equal("info");
  });
});
