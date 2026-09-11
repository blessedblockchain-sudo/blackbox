/**
 * OpenAI brain: Chat Completions with function tools.
 */
import OpenAI from "openai";
import { ToolNameMap, toOpenAITools } from "../bridge";
import type { Brain, EpisodeRequest, EpisodeResult, Toolbox } from "../types";
import type { Transcript } from "../transcript";

export const DEFAULT_OPENAI_MODEL = "gpt-5";

export class OpenAIBrain implements Brain {
  readonly provider = "openai";
  readonly model: string;
  private readonly client: OpenAI;
  private transcript?: Transcript;

  constructor(transcript?: Transcript, opts: { model?: string; apiKey?: string } = {}) {
    this.transcript = transcript;
    this.model = opts.model || process.env.BLACKBOX_OPENAI_MODEL || DEFAULT_OPENAI_MODEL;
    this.client = new OpenAI(opts.apiKey ? { apiKey: opts.apiKey } : {});
  }

  setTranscript(t: Transcript) {
    this.transcript = t;
  }

  async runEpisode(req: EpisodeRequest, toolbox: Toolbox, systemPrompt: string): Promise<EpisodeResult> {
    const names = new ToolNameMap(toolbox.specs.map((s) => s.name));
    const tools = toOpenAITools(toolbox.specs, names);
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: req.task },
    ];
    let finalText = "";
    let nudged = false;

    for (let round = 1; round <= req.maxRounds; round++) {
      let completion: OpenAI.Chat.Completions.ChatCompletion;
      try {
        completion = await this.client.chat.completions.create({ model: this.model, messages, tools });
      } catch (e) {
        const msg = e instanceof OpenAI.APIError ? `API error ${e.status}: ${e.message}` : String(e);
        return { rounds: round, finalText, error: msg };
      }
      const choice = completion.choices[0];
      const msg = choice?.message;
      if (!msg) return { rounds: round, finalText, error: "empty completion" };
      if (msg.content) finalText = msg.content.trim();
      this.transcript?.write({ type: "llm", turn: round, stop: choice.finish_reason ?? null, usage: completion.usage ? { ...completion.usage } : undefined, ...(msg.content ? { text: msg.content } : {}) });
      if (msg.refusal) return { rounds: round, finalText, error: `refusal: ${msg.refusal}` };

      const calls = (msg.tool_calls ?? []).filter((c): c is OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall => c.type === "function");
      if (calls.length === 0) {
        if (!nudged && req.nudge && round < req.maxRounds) {
          nudged = true;
          messages.push({ role: "assistant", content: msg.content ?? "" }, { role: "user", content: req.nudge });
          continue;
        }
        return { rounds: round, finalText };
      }

      messages.push({ role: "assistant", content: msg.content ?? null, tool_calls: calls });
      let done = false;
      for (const c of calls) {
        let args: Record<string, unknown> = {};
        let parseError: string | null = null;
        try {
          const parsed = c.function.arguments ? JSON.parse(c.function.arguments) : {};
          if (parsed && typeof parsed === "object") args = parsed;
        } catch (e) {
          parseError = `ERROR: arguments are not valid JSON (${String(e)})`;
        }
        const out = parseError ? { text: parseError, isError: true, final: false } : await toolbox.call(names.mcp(c.function.name), args);
        messages.push({ role: "tool", tool_call_id: c.id, content: out.text });
        if (out.final) done = true;
      }
      if (done) return { rounds: round, finalText };
    }
    return { rounds: req.maxRounds, finalText, error: "episode hit max rounds without a submission" };
  }
}
