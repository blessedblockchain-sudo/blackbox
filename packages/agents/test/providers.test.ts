/**
 * Provider loops against stubbed SDK clients: tool calls are routed through the
 * toolbox with MCP names, results go back in each provider's format, and the
 * loop stops once a submit tool is accepted.
 */
import { expect } from "chai";
import { ClaudeBrain } from "../src/providers/claude";
import { GeminiBrain } from "../src/providers/gemini";
import { OpenAIBrain } from "../src/providers/openai";
import { SUBMIT_DECISION } from "../src/toolbox";
import type { EpisodeRequest, ToolOutcome, Toolbox } from "../src/types";

class StubToolbox implements Toolbox {
  specs = [{ name: "get_round", description: "Round state", inputSchema: { type: "object", properties: {} } }, SUBMIT_DECISION];
  submitted: Toolbox["submitted"] = {};
  calls: { name: string; args: Record<string, unknown> }[] = [];
  async call(name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
    this.calls.push({ name, args });
    if (name === "submit_decision") {
      this.submitted.decision = { action: "hold", explanation: String(args.explanation) };
      return { text: "Recorded.", isError: false, final: true };
    }
    if (name === "get_round") return { text: "Round #1 live, tick 10", isError: false };
    return { text: `ERROR: unknown ${name}`, isError: true };
  }
}

const req: EpisodeRequest = {
  kind: "live",
  task: "decide",
  maxRounds: 5,
  context: { roundId: 1, phase: "live", markets: ["SOL-PERP"], symbols: ["SOL"], memory: { currentSource: null, strategyLabel: null, strategyVersion: null, swaps: 0, loops: 1, decisions: [], startingEquity: null }, prefetch: {}, marginUsdc: 100 },
};

describe("provider loops", () => {
  it("Claude: tool_use -> tool_result, stops after submit_decision", async () => {
    const brain = new ClaudeBrain(undefined, { apiKey: "test", model: "claude-sonnet-5" });
    const seen: any[] = [];
    const replies = [
      { stop_reason: "tool_use", usage: {}, content: [{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text: "Checking the round." }, { type: "tool_use", id: "tu_1", name: "get_round", input: {} }] },
      { stop_reason: "tool_use", usage: {}, content: [{ type: "tool_use", id: "tu_2", name: "submit_decision", input: { action: "hold", explanation: "Trend intact." } }] },
      { stop_reason: "end_turn", usage: {}, content: [{ type: "text", text: "should not be requested" }] },
    ];
    (brain as any).client = { messages: { create: async (p: any) => { seen.push(structuredClone(p)); return replies.shift(); } } };
    const tb = new StubToolbox();
    const res = await brain.runEpisode(req, tb, "SYSTEM");
    expect(res.error).to.equal(undefined);
    expect(res.rounds).to.equal(2);
    expect(tb.calls.map((c) => c.name)).to.deep.equal(["get_round", "submit_decision"]);
    expect(seen).to.have.length(2);
    expect(seen[0].model).to.equal("claude-sonnet-5");
    expect(seen[0].system).to.equal("SYSTEM");
    expect(seen[0].cache_control).to.deep.equal({ type: "ephemeral" });
    expect(seen[0].tools.map((t: any) => t.name)).to.deep.equal(["get_round", "submit_decision"]);
    expect(seen[0]).to.not.have.property("thinking");
    expect(seen[0]).to.not.have.property("temperature");
    // second request carries the assistant turn verbatim (thinking included) and the tool result
    const [, assistant, user] = seen[1].messages;
    expect(assistant.role).to.equal("assistant");
    expect(assistant.content[0].type).to.equal("thinking");
    expect(user.content).to.deep.equal([{ type: "tool_result", tool_use_id: "tu_1", content: "Round #1 live, tick 10" }]);
    expect(tb.submitted.decision?.explanation).to.equal("Trend intact.");
  });

  it("Claude: a refusal ends the episode with an error", async () => {
    const brain = new ClaudeBrain(undefined, { apiKey: "test" });
    (brain as any).client = { messages: { create: async () => ({ stop_reason: "refusal", stop_details: { type: "refusal", category: null, explanation: "no" }, usage: {}, content: [] }) } };
    const res = await brain.runEpisode(req, new StubToolbox(), "S");
    expect(res.error).to.match(/refusal/);
  });

  it("OpenAI: function tool_calls -> role tool messages, stops after submit_decision", async () => {
    const brain = new OpenAIBrain(undefined, { apiKey: "test", model: "gpt-test" });
    const seen: any[] = [];
    const replies = [
      { choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "get_round", arguments: "{}" } }, { id: "c2", type: "function", function: { name: "get_round", arguments: "{bad json" } }] } }] },
      { choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: "Holding.", tool_calls: [{ id: "c3", type: "function", function: { name: "submit_decision", arguments: JSON.stringify({ action: "hold", explanation: "Flat market." }) } }] } }] },
    ];
    (brain as any).client = { chat: { completions: { create: async (p: any) => { seen.push(structuredClone(p)); return replies.shift(); } } } };
    const tb = new StubToolbox();
    const res = await brain.runEpisode(req, tb, "SYSTEM");
    expect(res.error).to.equal(undefined);
    expect(tb.calls.map((c) => c.name)).to.deep.equal(["get_round", "submit_decision"]);
    expect(seen[0].messages[0]).to.deep.equal({ role: "system", content: "SYSTEM" });
    expect(seen[0].tools[0]).to.deep.equal({ type: "function", function: { name: "get_round", description: "Round state", parameters: { type: "object", properties: {} } } });
    const msgs = seen[1].messages;
    expect(msgs[2].role).to.equal("assistant");
    expect(msgs[3]).to.deep.equal({ role: "tool", tool_call_id: "c1", content: "Round #1 live, tick 10" });
    expect(msgs[4].tool_call_id).to.equal("c2");
    expect(msgs[4].content).to.match(/not valid JSON/);
    expect(res.finalText).to.equal("Holding.");
  });

  it("Gemini: functionCalls -> functionResponse parts, stops after submit_decision", async () => {
    const brain = new GeminiBrain(undefined, { apiKey: "test", model: "gemini-test" });
    const seen: any[] = [];
    const turn = (parts: any[]) => ({ candidates: [{ finishReason: "STOP", content: { role: "model", parts } }], functionCalls: parts.filter((p) => p.functionCall).map((p) => p.functionCall) });
    const replies = [
      turn([{ functionCall: { id: "g1", name: "get_round", args: {} }, thoughtSignature: "sig" }]),
      turn([{ text: "Done." }, { functionCall: { id: "g2", name: "submit_decision", args: { action: "hold", explanation: "Nothing changed." } } }]),
    ];
    (brain as any).ai = { models: { generateContent: async (p: any) => { seen.push(structuredClone(p)); return replies.shift(); } } };
    const tb = new StubToolbox();
    const res = await brain.runEpisode(req, tb, "SYSTEM");
    expect(res.error).to.equal(undefined);
    expect(tb.calls.map((c) => c.name)).to.deep.equal(["get_round", "submit_decision"]);
    expect(seen[0].config.systemInstruction).to.equal("SYSTEM");
    expect(seen[0].config.tools[0].functionDeclarations.map((d: any) => d.name)).to.deep.equal(["get_round", "submit_decision"]);
    const contents = seen[1].contents;
    expect(contents[1]).to.deep.equal({ role: "model", parts: [{ functionCall: { id: "g1", name: "get_round", args: {} }, thoughtSignature: "sig" }] });
    expect(contents[2]).to.deep.equal({ role: "user", parts: [{ functionResponse: { id: "g1", name: "get_round", response: { output: "Round #1 live, tick 10" } } }] });
    expect(res.finalText).to.equal("Done.");
  });

  it("nudges once when the model ends its turn without submitting", async () => {
    const brain = new ClaudeBrain(undefined, { apiKey: "test" });
    const seen: any[] = [];
    const replies = [
      { stop_reason: "end_turn", usage: {}, content: [{ type: "text", text: "I would hold." }] },
      { stop_reason: "tool_use", usage: {}, content: [{ type: "tool_use", id: "tu_9", name: "submit_decision", input: { action: "hold", explanation: "Holding." } }] },
    ];
    (brain as any).client = { messages: { create: async (p: any) => { seen.push(structuredClone(p)); return replies.shift(); } } };
    const tb = new StubToolbox();
    const res = await brain.runEpisode({ ...req, nudge: "Call submit_decision now." }, tb, "S");
    expect(res.error).to.equal(undefined);
    expect(tb.submitted.decision?.explanation).to.equal("Holding.");
    expect(seen[1].messages.slice(1)).to.deep.equal([
      { role: "assistant", content: [{ type: "text", text: "I would hold." }] },
      { role: "user", content: "Call submit_decision now." },
    ]);
  });

  it("stops at maxRounds when the model never submits", async () => {
    const brain = new ClaudeBrain(undefined, { apiKey: "test" });
    (brain as any).client = { messages: { create: async () => ({ stop_reason: "tool_use", usage: {}, content: [{ type: "tool_use", id: `t${Math.random()}`, name: "get_round", input: {} }] }) } };
    const res = await brain.runEpisode({ ...req, maxRounds: 3 }, new StubToolbox(), "S");
    expect(res.rounds).to.equal(3);
    expect(res.error).to.match(/max rounds/);
  });
});
