/**
 * Claude brain: Anthropic Messages API with client-side tool use, driven by a
 * manual loop so every call goes through the episode toolbox (policy checks,
 * transcripts) and the loop stops as soon as a submit tool is accepted.
 */
import Anthropic from "@anthropic-ai/sdk";
import { ToolNameMap, toAnthropicTools } from "../bridge";
import type { Brain, EpisodeRequest, EpisodeResult, Toolbox } from "../types";
import type { Transcript } from "../transcript";

export const DEFAULT_CLAUDE_MODEL = "claude-sonnet-5";

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export class ClaudeBrain implements Brain {
  readonly provider = "claude";
  readonly model: string;
  private readonly client: Anthropic;
  private readonly effort?: Effort;
  private transcript?: Transcript;

  constructor(transcript?: Transcript, opts: { model?: string; apiKey?: string; effort?: string } = {}) {
    this.transcript = transcript;
    this.model = opts.model || process.env.BLACKBOX_CLAUDE_MODEL || DEFAULT_CLAUDE_MODEL;
    this.client = new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});
    const e = opts.effort || process.env.BLACKBOX_CLAUDE_EFFORT;
    if (e && ["low", "medium", "high", "xhigh", "max"].includes(e)) this.effort = e as Effort;
  }

  setTranscript(t: Transcript) {
    this.transcript = t;
  }

  async runEpisode(req: EpisodeRequest, toolbox: Toolbox, systemPrompt: string): Promise<EpisodeResult> {
    const names = new ToolNameMap(toolbox.specs.map((s) => s.name));
    const tools = toAnthropicTools(toolbox.specs, names);
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: req.task }];
    let finalText = "";
    let nudged = false;

    for (let round = 1; round <= req.maxRounds; round++) {
      let response: Anthropic.Message;
      try {
        response = await this.client.messages.create({
          model: this.model,
          max_tokens: 16000,
          // Stable prefix (tools + system) is cached across loops; auto-caching also covers the growing episode.
          cache_control: { type: "ephemeral" },
          system: systemPrompt,
          tools,
          messages,
          ...(this.effort ? { output_config: { effort: this.effort } } : {}),
        });
      } catch (e) {
        const msg = e instanceof Anthropic.RateLimitError ? `rate limited: ${e.message}` : e instanceof Anthropic.APIError ? `API error ${e.status}: ${e.message}` : String(e);
        return { rounds: round, finalText, error: msg };
      }

      const text = response.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
      if (text) finalText = text;
      this.transcript?.write({ type: "llm", turn: round, stop: response.stop_reason, usage: { ...response.usage }, ...(text ? { text } : {}) });

      if (response.stop_reason === "refusal") return { rounds: round, finalText, error: `refusal: ${response.stop_details?.explanation ?? "no details"}` };

      const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
        if (!nudged && req.nudge && round < req.maxRounds && response.stop_reason === "end_turn") {
          nudged = true;
          messages.push({ role: "assistant", content: response.content }, { role: "user", content: req.nudge });
          continue;
        }
        return { rounds: round, finalText };
      }

      // Keep the full assistant content (thinking blocks included) in the history.
      messages.push({ role: "assistant", content: response.content });
      const results: Anthropic.ToolResultBlockParam[] = [];
      let done = false;
      for (const tu of toolUses) {
        const input = tu.input && typeof tu.input === "object" ? (tu.input as Record<string, unknown>) : {};
        const out = await toolbox.call(names.mcp(tu.name), input);
        results.push({ type: "tool_result", tool_use_id: tu.id, content: out.text, ...(out.isError ? { is_error: true } : {}) });
        if (out.final) done = true;
      }
      if (done) return { rounds: round, finalText };
      messages.push({ role: "user", content: results });
    }
    return { rounds: req.maxRounds, finalText, error: "episode hit max rounds without a submission" };
  }
}
