/**
 * MCP -> provider tool bridge. Converts MCP tool descriptors (JSON Schema
 * input schemas) into Anthropic, OpenAI and Gemini tool definitions, and MCP
 * tool results into plain text for the model. Pure functions, no I/O.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import type { FunctionDeclaration, Schema } from "@google/genai";
import type { JsonSchema, ToolSpec } from "./types";

// Mirrors the @google/genai `Type` enum values; kept as literals so this module
// has no runtime dependency on the Gemini SDK.
type GeminiType = "STRING" | "NUMBER" | "INTEGER" | "BOOLEAN" | "ARRAY" | "OBJECT" | "NULL";

const isObj = (v: unknown): v is JsonSchema => typeof v === "object" && v !== null && !Array.isArray(v);

// ------------------------------------------------------------ names

/**
 * Provider-safe tool names. OpenAI allows [A-Za-z0-9_-]{1,64}; Gemini requires a
 * leading letter or underscore. MCP names are usually already safe, but the
 * bridge is generic, so it maps both ways and keeps the result collision-free.
 */
export class ToolNameMap {
  private toProvider = new Map<string, string>();
  private toMcp = new Map<string, string>();

  constructor(names: string[]) {
    for (const n of names) {
      let safe = n.replace(/[^A-Za-z0-9_-]/g, "_");
      if (!/^[A-Za-z_]/.test(safe)) safe = `_${safe}`;
      safe = safe.slice(0, 64);
      let candidate = safe;
      for (let i = 2; this.toMcp.has(candidate); i++) candidate = `${safe.slice(0, 60)}_${i}`;
      this.toProvider.set(n, candidate);
      this.toMcp.set(candidate, n);
    }
  }

  provider(mcpName: string): string {
    return this.toProvider.get(mcpName) ?? mcpName;
  }

  mcp(providerName: string): string {
    return this.toMcp.get(providerName) ?? providerName;
  }
}

// ------------------------------------------------------------ JSON Schema clean-up

/** Resolve a local `#/$defs/x` or `#/definitions/x` reference against the root schema. */
function resolveRef(ref: string, root: JsonSchema): JsonSchema | null {
  const m = /^#\/(\$defs|definitions)\/(.+)$/.exec(ref);
  if (!m) return null;
  const defs = root[m[1]];
  if (!isObj(defs)) return null;
  const hit = defs[decodeURIComponent(m[2]).replace(/~1/g, "/").replace(/~0/g, "~")];
  return isObj(hit) ? hit : null;
}

/** Inline local $refs (bounded depth, cycles cut to `{}`), drop `$schema`/`$defs`. */
export function inlineRefs(schema: JsonSchema, root: JsonSchema = schema, depth = 0): JsonSchema {
  if (depth > 24) return {};
  if (typeof schema.$ref === "string") {
    const target = resolveRef(schema.$ref, root);
    const { $ref: _r, ...rest } = schema;
    return target ? inlineRefs({ ...target, ...rest }, root, depth + 1) : rest;
  }
  const out: JsonSchema = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === "$schema" || k === "$defs" || k === "definitions" || k === "$id") continue;
    if (k === "properties" && isObj(v)) {
      const props: JsonSchema = {};
      for (const [pk, pv] of Object.entries(v)) props[pk] = isObj(pv) ? inlineRefs(pv, root, depth + 1) : pv;
      out[k] = props;
    } else if ((k === "items" || k === "additionalProperties" || k === "not") && isObj(v)) {
      out[k] = inlineRefs(v, root, depth + 1);
    } else if ((k === "anyOf" || k === "oneOf" || k === "allOf" || k === "prefixItems") && Array.isArray(v)) {
      out[k] = v.map((s) => (isObj(s) ? inlineRefs(s, root, depth + 1) : s));
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Normalize an MCP input schema into a top-level object schema with `properties`. */
export function objectSchema(input: JsonSchema | undefined): JsonSchema {
  const s = isObj(input) ? inlineRefs(input) : {};
  const out: JsonSchema = { ...s, type: "object" };
  if (!isObj(out.properties)) out.properties = {};
  if (Array.isArray(out.required)) {
    const props = out.properties as JsonSchema;
    out.required = (out.required as unknown[]).filter((r) => typeof r === "string" && r in props);
    if ((out.required as unknown[]).length === 0) delete out.required;
  }
  return out;
}

// ------------------------------------------------------------ Anthropic

export function toAnthropicTools(specs: ToolSpec[], names = new ToolNameMap(specs.map((s) => s.name))): Anthropic.Tool[] {
  return specs.map((s) => ({
    name: names.provider(s.name),
    description: s.description ?? s.name,
    input_schema: objectSchema(s.inputSchema) as Anthropic.Tool.InputSchema,
  }));
}

// ------------------------------------------------------------ OpenAI

export function toOpenAITools(specs: ToolSpec[], names = new ToolNameMap(specs.map((s) => s.name))): OpenAI.Chat.Completions.ChatCompletionFunctionTool[] {
  return specs.map((s) => ({
    type: "function" as const,
    function: {
      name: names.provider(s.name),
      description: s.description ?? s.name,
      parameters: objectSchema(s.inputSchema),
    },
  }));
}

// ------------------------------------------------------------ Gemini

const GEMINI_FORMATS: Record<string, readonly string[]> = {
  STRING: ["enum", "date-time"],
  NUMBER: ["float", "double"],
  INTEGER: ["int32", "int64"],
};

function geminiType(t: unknown): GeminiType | null {
  switch (t) {
    case "string": return "STRING";
    case "number": return "NUMBER";
    case "integer": return "INTEGER";
    case "boolean": return "BOOLEAN";
    case "array": return "ARRAY";
    case "object": return "OBJECT";
    case "null": return "NULL";
    default: return null;
  }
}

function guessType(s: JsonSchema): string | undefined {
  if (typeof s.type === "string") return s.type;
  if (isObj(s.properties)) return "object";
  if (isObj(s.items)) return "array";
  if (Array.isArray(s.enum) && s.enum.length) {
    if (s.enum.every((v) => typeof v === "string")) return "string";
    if (s.enum.every((v) => typeof v === "number")) return s.enum.every((v) => Number.isInteger(v)) ? "integer" : "number";
    if (s.enum.every((v) => typeof v === "boolean")) return "boolean";
    return undefined;
  }
  if (s.const !== undefined) return typeof s.const === "number" ? "number" : typeof s.const === "boolean" ? "boolean" : "string";
  return undefined;
}

/**
 * Convert one JSON Schema node into Gemini's OpenAPI-3.0 `Schema` subset:
 * upper-case types, `nullable` instead of `type: [.., "null"]` / `anyOf null`,
 * string enums only, numeric length bounds as strings, and no
 * `additionalProperties` / `$schema` / other unsupported keywords.
 */
export function toGeminiSchema(node: JsonSchema, depth = 0): Schema {
  if (depth > 24) return {};
  let s: JsonSchema = node;

  // allOf: shallow merge (zod emits it for intersections)
  if (Array.isArray(s.allOf)) {
    const merged: JsonSchema = { ...s };
    delete merged.allOf;
    for (const part of s.allOf) {
      if (!isObj(part)) continue;
      for (const [k, v] of Object.entries(part)) {
        if (k === "properties" && isObj(v)) merged.properties = { ...(isObj(merged.properties) ? merged.properties : {}), ...v };
        else if (k === "required" && Array.isArray(v)) merged.required = [...(Array.isArray(merged.required) ? merged.required : []), ...v];
        else if (!(k in merged)) merged[k] = v;
      }
    }
    s = merged;
  }

  const out: Schema = {};
  let nullable = s.nullable === true;

  // anyOf / oneOf, peeling off null variants
  const union = Array.isArray(s.anyOf) ? s.anyOf : Array.isArray(s.oneOf) ? s.oneOf : null;
  if (union) {
    const variants = union.filter(isObj).filter((v) => {
      if (v.type === "null") { nullable = true; return false; }
      return true;
    });
    const rest: JsonSchema = { ...s };
    delete rest.anyOf;
    delete rest.oneOf;
    if (variants.length === 1) {
      const inner = toGeminiSchema({ ...variants[0], ...rest }, depth + 1);
      if (nullable) inner.nullable = true;
      return inner;
    }
    if (variants.length > 1) {
      out.anyOf = variants.map((v) => toGeminiSchema(v, depth + 1));
      if (typeof s.description === "string") out.description = s.description;
      if (nullable) out.nullable = true;
      return out;
    }
  }

  // type, including JSON Schema type arrays
  let jsonType: unknown = s.type;
  if (Array.isArray(jsonType)) {
    const nonNull = jsonType.filter((t) => t !== "null");
    if (nonNull.length !== jsonType.length) nullable = true;
    if (nonNull.length > 1) {
      const rest: JsonSchema = { ...s };
      delete rest.type;
      out.anyOf = nonNull.map((t) => toGeminiSchema({ ...rest, type: t }, depth + 1));
      if (nullable) out.nullable = true;
      return out;
    }
    jsonType = nonNull[0];
  }
  if (jsonType === undefined) jsonType = guessType(s);
  const gt = geminiType(jsonType);
  if (gt) out.type = gt as Schema["type"];

  if (typeof s.title === "string") out.title = s.title;
  if (typeof s.description === "string") out.description = s.description;
  if (nullable) out.nullable = true;

  // enums: Gemini only supports string enums
  if (Array.isArray(s.enum) || s.const !== undefined) {
    const values = Array.isArray(s.enum) ? s.enum : [s.const];
    const allStrings = values.every((v) => typeof v === "string");
    if (allStrings) {
      out.type = "STRING" as Schema["type"];
      out.enum = values as string[];
      out.format = "enum";
    } else {
      const note = `Allowed values: ${values.map((v) => JSON.stringify(v)).join(", ")}.`;
      out.description = out.description ? `${out.description} ${note}` : note;
    }
  }

  if (typeof s.format === "string" && !out.format && gt && GEMINI_FORMATS[gt]?.includes(s.format)) out.format = s.format;
  if (typeof s.pattern === "string") out.pattern = s.pattern;
  if (s.default !== undefined) out.default = s.default;

  if (typeof s.minimum === "number") out.minimum = s.minimum;
  else if (typeof s.exclusiveMinimum === "number") out.minimum = s.exclusiveMinimum;
  if (typeof s.maximum === "number") out.maximum = s.maximum;
  else if (typeof s.exclusiveMaximum === "number") out.maximum = s.exclusiveMaximum;
  for (const k of ["minItems", "maxItems", "minLength", "maxLength", "minProperties", "maxProperties"] as const) {
    if (typeof s[k] === "number") out[k] = String(s[k]);
  }

  if (isObj(s.items)) out.items = toGeminiSchema(s.items, depth + 1);
  else if (Array.isArray(s.prefixItems) && isObj(s.prefixItems[0])) out.items = toGeminiSchema(s.prefixItems[0], depth + 1);

  if (isObj(s.properties)) {
    const props: Record<string, Schema> = {};
    const keys = Object.keys(s.properties);
    for (const k of keys) {
      const v = (s.properties as JsonSchema)[k];
      props[k] = isObj(v) ? toGeminiSchema(v, depth + 1) : {};
    }
    out.properties = props;
    if (keys.length > 1) out.propertyOrdering = keys;
    if (Array.isArray(s.required)) {
      const req = s.required.filter((r): r is string => typeof r === "string" && r in props);
      if (req.length) out.required = req;
    }
  }
  return out;
}

export function toGeminiTools(specs: ToolSpec[], names = new ToolNameMap(specs.map((s) => s.name))): FunctionDeclaration[] {
  return specs.map((s) => {
    const schema = objectSchema(s.inputSchema);
    const decl: FunctionDeclaration = { name: names.provider(s.name), description: s.description ?? s.name };
    // Gemini rejects OBJECT parameters with no properties; omit parameters for no-arg tools.
    if (Object.keys(schema.properties as JsonSchema).length > 0) decl.parameters = toGeminiSchema(schema);
    return decl;
  });
}

// ------------------------------------------------------------ results

/** Shape of an MCP CallToolResult as far as the bridge cares. */
export interface McpCallResult {
  content?: unknown;
  structuredContent?: unknown;
  isError?: boolean;
  toolResult?: unknown;
}

/** Flatten an MCP tool result into text for any provider. */
export function mcpResultToText(result: McpCallResult, maxChars = 8000): string {
  const parts: string[] = [];
  const content = Array.isArray(result.content) ? result.content : [];
  // Servers often repeat structuredContent as a JSON text block; the model gets the summary text once.
  const structuredJson = result.structuredContent !== undefined ? JSON.stringify(result.structuredContent) : null;
  const hasOtherText = content.some((c) => isObj(c) && c.type === "text" && typeof c.text === "string" && c.text.trim() !== structuredJson);
  for (const c of content) {
    if (!isObj(c)) continue;
    if (c.type === "text" && typeof c.text === "string") {
      if (hasOtherText && structuredJson !== null && c.text.trim() === structuredJson) continue;
      parts.push(c.text);
    }
    else if (c.type === "image") parts.push(`[image ${String(c.mimeType ?? "")}]`);
    else if (c.type === "audio") parts.push(`[audio ${String(c.mimeType ?? "")}]`);
    else if (c.type === "resource" && isObj(c.resource)) parts.push(typeof c.resource.text === "string" ? c.resource.text : `[resource ${String(c.resource.uri ?? "")}]`);
    else if (c.type === "resource_link") parts.push(`[resource ${String(c.uri ?? "")}]`);
  }
  if (parts.length === 0 && result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent));
  if (parts.length === 0 && result.toolResult !== undefined) parts.push(JSON.stringify(result.toolResult));
  let text = parts.join("\n").trim() || "(empty result)";
  if (result.isError) text = `ERROR: ${text}`;
  return truncate(text, maxChars);
}

export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n... [truncated ${text.length - maxChars} chars]`;
}

/** One-line summary for logs and transcripts. */
export function summarize(text: string, max = 160): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 3)}...` : one;
}

/** Explorer links and bare signatures found in a tool result. */
export function extractTxLinks(text: string, structured?: unknown): string[] {
  const found = new Set<string>();
  const scan = (s: string) => {
    for (const m of s.matchAll(/https?:\/\/explorer\.solana\.com\/tx\/[^\s)"'\]>]+/g)) found.add(m[0].replace(/[.,;:]+$/, ""));
  };
  scan(text);
  const walk = (v: unknown, depth: number) => {
    if (depth > 6) return;
    if (typeof v === "string") {
      scan(v);
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, depth + 1));
    else if (isObj(v)) Object.values(v).forEach((x) => walk(x, depth + 1));
  };
  walk(structured, 0);
  return [...found];
}
