import { expect } from "chai";
import {
  ToolNameMap,
  extractTxLinks,
  inlineRefs,
  mcpResultToText,
  objectSchema,
  toAnthropicTools,
  toGeminiSchema,
  toGeminiTools,
  toOpenAITools,
} from "../src/bridge";
import { SUBMIT_DECISION, SUBMIT_STRATEGY } from "../src/toolbox";
import type { ToolSpec } from "../src/types";

const DRAFT7 = "http://json-schema.org/draft-07/schema#";

/** Tool list shaped like what an McpServer with zod schemas emits over tools/list. */
const MCP_TOOLS: ToolSpec[] = [
  { name: "get_round", description: "Round state.", inputSchema: { type: "object", properties: {}, additionalProperties: false, $schema: DRAFT7 } },
  {
    name: "get_market_history",
    description: "Recent marks.",
    inputSchema: {
      type: "object",
      properties: {
        market: { type: "string", enum: ["SOL-PERP", "BTC-PERP"], description: "Market name" },
        n: { type: "integer", minimum: 1, maximum: 64, default: 64 },
      },
      required: ["market"],
      additionalProperties: false,
      $schema: DRAFT7,
    },
  },
  {
    name: "enter_round",
    description: "Enter.",
    inputSchema: {
      type: "object",
      properties: { source: { type: "string" }, margin_usdc: { type: "number", exclusiveMinimum: 0 } },
      required: ["source", "margin_usdc"],
      additionalProperties: false,
      $schema: DRAFT7,
    },
  },
  {
    name: "simulate_strategy",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string" },
        market_history: { anyOf: [{ type: "array", items: { $ref: "#/$defs/tick" }, minItems: 2 }, { type: "null" }] },
        seed: { type: ["integer", "null"] },
        mode: { const: "fast" },
        weights: { enum: [1, 2, 3] },
      },
      required: ["source", "not_a_property"],
      $defs: { tick: { type: "object", properties: { prices: { type: "array", items: { type: "number" } } }, required: ["prices"], additionalProperties: false } },
      $schema: "https://json-schema.org/draft/2020-12/schema",
    },
  },
];

describe("MCP -> provider tool bridge", () => {
  describe("ToolNameMap", () => {
    it("keeps safe names and maps both ways", () => {
      const m = new ToolNameMap(["get_round", "read-scoreboard"]);
      expect(m.provider("get_round")).to.equal("get_round");
      expect(m.provider("read-scoreboard")).to.equal("read-scoreboard");
      expect(m.mcp("get_round")).to.equal("get_round");
    });

    it("sanitizes invalid characters, leading digits and length, without collisions", () => {
      const m = new ToolNameMap(["blackbox.get round", "blackbox_get_round", "9lives", "x".repeat(80)]);
      const a = m.provider("blackbox.get round");
      const b = m.provider("blackbox_get_round");
      expect(a).to.match(/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/);
      expect(b).to.match(/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/);
      expect(a).to.not.equal(b);
      expect(m.mcp(a)).to.equal("blackbox.get round");
      expect(m.mcp(b)).to.equal("blackbox_get_round");
      expect(m.provider("9lives")).to.equal("_9lives");
      expect(m.provider("x".repeat(80)).length).to.equal(64);
    });
  });

  describe("JSON Schema normalization", () => {
    it("inlines local $refs and drops $schema/$defs", () => {
      const s = inlineRefs(MCP_TOOLS[3].inputSchema);
      expect(s).to.not.have.property("$schema");
      expect(s).to.not.have.property("$defs");
      const mh = (s.properties as any).market_history;
      expect(mh.anyOf[0].items).to.deep.include({ type: "object", required: ["prices"] });
    });

    it("cuts reference cycles instead of recursing forever", () => {
      const cyclic = { type: "object", properties: { node: { $ref: "#/$defs/n" } }, $defs: { n: { type: "object", properties: { next: { $ref: "#/$defs/n" } } } } };
      expect(() => JSON.stringify(inlineRefs(cyclic))).to.not.throw();
    });

    it("produces a top-level object schema with properties and only real required keys", () => {
      expect(objectSchema(undefined)).to.deep.equal({ type: "object", properties: {} });
      const s = objectSchema(MCP_TOOLS[3].inputSchema);
      expect(s.type).to.equal("object");
      expect(s.required).to.deep.equal(["source"]);
    });
  });

  describe("Anthropic", () => {
    it("converts every tool to name/description/input_schema", () => {
      const tools = toAnthropicTools(MCP_TOOLS);
      expect(tools.map((t) => t.name)).to.deep.equal(MCP_TOOLS.map((t) => t.name));
      for (const t of tools) {
        expect(t.input_schema.type).to.equal("object");
        expect(t.input_schema).to.not.have.property("$schema");
        expect(t.description).to.be.a("string").and.not.empty;
      }
      expect(tools[3].description).to.equal("simulate_strategy");
      expect((tools[1].input_schema.properties as any).market.enum).to.deep.equal(["SOL-PERP", "BTC-PERP"]);
      expect(tools[2].input_schema.required).to.deep.equal(["source", "margin_usdc"]);
    });
  });

  describe("OpenAI", () => {
    it("wraps each tool as a function tool with JSON Schema parameters", () => {
      const tools = toOpenAITools(MCP_TOOLS);
      expect(tools).to.have.length(4);
      for (const t of tools) {
        expect(t.type).to.equal("function");
        expect(t.function.parameters).to.have.property("type", "object");
        expect(t.function.parameters).to.have.property("properties");
        expect(t.function.parameters).to.not.have.property("$schema");
      }
      expect(tools[0].function.parameters).to.deep.equal({ type: "object", properties: {}, additionalProperties: false });
      expect((tools[2].function.parameters as any).properties.margin_usdc).to.deep.equal({ type: "number", exclusiveMinimum: 0 });
    });
  });

  describe("Gemini", () => {
    it("omits parameters for no-argument tools", () => {
      const [getRound] = toGeminiTools(MCP_TOOLS);
      expect(getRound.name).to.equal("get_round");
      expect(getRound).to.not.have.property("parameters");
    });

    it("maps types to the OpenAPI subset and drops unsupported keywords", () => {
      const decl = toGeminiTools(MCP_TOOLS)[1];
      expect(decl.parameters).to.deep.equal({
        type: "OBJECT",
        properties: {
          market: { type: "STRING", description: "Market name", enum: ["SOL-PERP", "BTC-PERP"], format: "enum" },
          n: { type: "INTEGER", minimum: 1, maximum: 64, default: 64 },
        },
        propertyOrdering: ["market", "n"],
        required: ["market"],
      });
    });

    it("turns exclusiveMinimum into minimum", () => {
      const p = toGeminiTools(MCP_TOOLS)[2].parameters as any;
      expect(p.properties.margin_usdc).to.deep.equal({ type: "NUMBER", minimum: 0 });
    });

    it("handles null unions, type arrays, $refs, const and non-string enums", () => {
      const p = toGeminiTools(MCP_TOOLS)[3].parameters as any;
      expect(p.required).to.deep.equal(["source"]);
      expect(p.properties.market_history).to.deep.equal({
        type: "ARRAY",
        nullable: true,
        minItems: "2",
        items: { type: "OBJECT", properties: { prices: { type: "ARRAY", items: { type: "NUMBER" } } }, required: ["prices"] },
      });
      expect(p.properties.seed).to.deep.equal({ type: "INTEGER", nullable: true });
      expect(p.properties.mode).to.deep.equal({ type: "STRING", enum: ["fast"], format: "enum" });
      expect(p.properties.weights.type).to.equal("INTEGER");
      expect(p.properties.weights).to.not.have.property("enum");
      expect(p.properties.weights.description).to.equal("Allowed values: 1, 2, 3.");
      expect(JSON.stringify(p)).to.not.match(/additionalProperties|\$schema|\$ref|\$defs/);
    });

    it("keeps multi-type unions as anyOf and merges allOf", () => {
      expect(toGeminiSchema({ type: ["string", "number"] })).to.deep.equal({ anyOf: [{ type: "STRING" }, { type: "NUMBER" }] });
      expect(toGeminiSchema({ anyOf: [{ type: "string" }, { type: "integer" }, { type: "null" }], description: "id" })).to.deep.equal({
        anyOf: [{ type: "STRING" }, { type: "INTEGER" }],
        description: "id",
        nullable: true,
      });
      expect(
        toGeminiSchema({ allOf: [{ type: "object", properties: { a: { type: "string" } }, required: ["a"] }, { properties: { b: { type: "boolean" } } }] }),
      ).to.deep.equal({ type: "OBJECT", properties: { a: { type: "STRING" }, b: { type: "BOOLEAN" } }, propertyOrdering: ["a", "b"], required: ["a"] });
    });

    it("converts the runner's own submit tools", () => {
      const [strategy, decision] = toGeminiTools([SUBMIT_STRATEGY, SUBMIT_DECISION]);
      expect((strategy.parameters as any).required).to.deep.equal(["source", "margin_usdc", "rationale"]);
      expect((decision.parameters as any).properties.action).to.deep.include({ type: "STRING", enum: ["hold", "hot_swapped"] });
    });
  });

  describe("tool results", () => {
    it("joins text content and marks errors", () => {
      expect(mcpResultToText({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] })).to.equal("a\nb");
      expect(mcpResultToText({ content: [{ type: "text", text: "boom" }], isError: true })).to.equal("ERROR: boom");
      expect(mcpResultToText({ content: [{ type: "image", mimeType: "image/png", data: "x" }] })).to.equal("[image image/png]");
    });

    it("falls back to structured content and truncates long output", () => {
      expect(mcpResultToText({ content: [], structuredContent: { ok: true } })).to.equal('{"ok":true}');
      expect(mcpResultToText({})).to.equal("(empty result)");
      const long = mcpResultToText({ content: [{ type: "text", text: "x".repeat(100) }] }, 10);
      expect(long.startsWith("x".repeat(10))).to.equal(true);
      expect(long).to.contain("[truncated 90 chars]");
    });

    it("extracts explorer links from text and structured content", () => {
      const links = extractTxLinks("sent https://explorer.solana.com/tx/abc?cluster=devnet.", { nested: { tx: "https://explorer.solana.com/tx/def?cluster=custom" } });
      expect(links).to.deep.equal(["https://explorer.solana.com/tx/abc?cluster=devnet", "https://explorer.solana.com/tx/def?cluster=custom"]);
    });
  });
});
