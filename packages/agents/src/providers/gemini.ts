/**
 * Gemini brain: @google/genai generateContent with function declarations.
 */
import { GoogleGenAI, type Content, type GenerateContentResponse, type Part } from "@google/genai";
import { ToolNameMap, toGeminiTools } from "../bridge";
import type { Brain, EpisodeRequest, EpisodeResult, Toolbox } from "../types";
import type { Transcript } from "../transcript";

export const DEFAULT_GEMINI_MODEL = "gemini-2.5-pro";

export class GeminiBrain implements Brain {
  readonly provider = "gemini";
  readonly model: string;
  private readonly ai: GoogleGenAI;
  private transcript?: Transcript;

  constructor(transcript?: Transcript, opts: { model?: string; apiKey?: string } = {}) {
    this.transcript = transcript;
    this.model = opts.model || process.env.BLACKBOX_GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
    this.ai = new GoogleGenAI({ apiKey: opts.apiKey ?? process.env.GEMINI_API_KEY });
  }

  setTranscript(t: Transcript) {
    this.transcript = t;
  }

  async runEpisode(req: EpisodeRequest, toolbox: Toolbox, systemPrompt: string): Promise<EpisodeResult> {
    const names = new ToolNameMap(toolbox.specs.map((s) => s.name));
    const functionDeclarations = toGeminiTools(toolbox.specs, names);
    const contents: Content[] = [{ role: "user", parts: [{ text: req.task }] }];
    let finalText = "";
    let nudged = false;

    for (let round = 1; round <= req.maxRounds; round++) {
      let response: GenerateContentResponse;
      try {
        response = await this.ai.models.generateContent({
          model: this.model,
          contents,
          config: { systemInstruction: systemPrompt, tools: [{ functionDeclarations }] },
        });
      } catch (e) {
        return { rounds: round, finalText, error: `API error: ${e instanceof Error ? e.message : String(e)}` };
      }
      const candidate = response.candidates?.[0];
      const content = candidate?.content;
      const text = (content?.parts ?? []).filter((p) => typeof p.text === "string" && !p.thought).map((p) => p.text).join("\n").trim();
      if (text) finalText = text;
      this.transcript?.write({ type: "llm", turn: round, stop: candidate?.finishReason ?? null, usage: response.usageMetadata ? { ...response.usageMetadata } : undefined, ...(text ? { text } : {}) });

      const calls = response.functionCalls ?? [];
      if (!content) return { rounds: round, finalText, error: `no content (finish ${candidate?.finishReason ?? "unknown"})` };
      if (calls.length === 0) {
        if (!nudged && req.nudge && round < req.maxRounds) {
          nudged = true;
          contents.push(content, { role: "user", parts: [{ text: req.nudge }] });
          continue;
        }
        return { rounds: round, finalText };
      }

      // Append the model turn as returned (keeps thought signatures intact).
      contents.push(content);
      const parts: Part[] = [];
      let done = false;
      for (const c of calls) {
        const name = c.name ?? "";
        const out = await toolbox.call(names.mcp(name), c.args ?? {});
        parts.push({ functionResponse: { id: c.id, name, response: out.isError ? { error: out.text } : { output: out.text } } });
        if (out.final) done = true;
      }
      if (done) return { rounds: round, finalText };
      contents.push({ role: "user", parts });
    }
    return { rounds: req.maxRounds, finalText, error: "episode hit max rounds without a submission" };
  }
}
