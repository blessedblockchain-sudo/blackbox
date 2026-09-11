/**
 * BXL lexer. Produces a flat token list with 1-based line/col positions.
 *
 * - `#` starts a line comment.
 * - Newlines (and `;`) separate statements; they are suppressed inside
 *   parentheses and brackets so long expressions can wrap.
 * - A number immediately followed by `%` is a percent literal (`30%`), unless
 *   the `%` is followed by an operand (`10%3`, `x % 4`), which makes it modulo.
 */

export type TokKind = "num" | "ident" | "kw" | "op" | "nl" | "eof";

export interface Token {
  kind: TokKind;
  text: string;
  line: number;
  col: number;
  /** Number tokens only: written with a `%` suffix. */
  pct?: boolean;
}

export class BxlSyntaxError extends Error {
  constructor(readonly line: number, readonly col: number, message: string) {
    super(message);
  }
}

export const KEYWORDS = new Set(["let", "if", "elif", "else", "and", "or", "not", "true", "false", "mem"]);

const OPS2 = ["<=", ">=", "==", "!=", "&&", "||"];
const OPS1 = ["+", "-", "*", "/", "%", "<", ">", "=", "(", ")", "{", "}", "[", "]", ",", "!"];

const isDigit = (c: string) => c >= "0" && c <= "9";
const isIdStart = (c: string) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
const isIdChar = (c: string) => isIdStart(c) || isDigit(c);

export function lex(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  let line = 1;
  let col = 1;
  let depth = 0; // ( and [ nesting
  const n = src.length;

  const push = (kind: TokKind, text: string, l: number, c: number, extra: Partial<Token> = {}) => {
    out.push({ kind, text, line: l, col: c, ...extra });
  };
  const newline = (l: number, c: number, text: string) => {
    if (depth > 0) return;
    const last = out[out.length - 1];
    if (!last || last.kind === "nl") return; // collapse blank lines / leading newlines
    push("nl", text, l, c);
  };

  while (i < n) {
    const c = src[i];
    if (c === "\n") {
      newline(line, col, "\\n");
      i++;
      line++;
      col = 1;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      i++;
      col++;
      continue;
    }
    if (c === "#") {
      while (i < n && src[i] !== "\n") {
        i++;
        col++;
      }
      continue;
    }
    if (c === ";") {
      newline(line, col, ";");
      i++;
      col++;
      continue;
    }
    const l0 = line;
    const c0 = col;
    // numbers: 12, 1.5, .5, 1_000
    if (isDigit(c) || (c === "." && i + 1 < n && isDigit(src[i + 1]))) {
      let j = i;
      while (j < n && (isDigit(src[j]) || src[j] === "_")) j++;
      if (j < n && src[j] === "." && j + 1 < n && isDigit(src[j + 1])) {
        j++;
        while (j < n && (isDigit(src[j]) || src[j] === "_")) j++;
      }
      if (j < n && isIdStart(src[j])) {
        throw new BxlSyntaxError(l0, c0 + (j - i), `unexpected '${src[j]}' after number ${src.slice(i, j)}`);
      }
      const text = src.slice(i, j);
      let pct = false;
      if (j < n && src[j] === "%" && !percentIsModulo(src, j + 1)) {
        pct = true;
        j++;
      }
      push("num", text, l0, c0, { pct });
      col += j - i;
      i = j;
      continue;
    }
    if (isIdStart(c)) {
      let j = i;
      while (j < n && isIdChar(src[j])) j++;
      const text = src.slice(i, j);
      push(KEYWORDS.has(text) ? "kw" : "ident", text, l0, c0);
      col += j - i;
      i = j;
      continue;
    }
    const two = src.slice(i, i + 2);
    const op = OPS2.includes(two) ? two : OPS1.includes(c) ? c : null;
    if (op) {
      if (op === "(" || op === "[") depth++;
      if ((op === ")" || op === "]") && depth > 0) depth--;
      push("op", op, l0, c0);
      i += op.length;
      col += op.length;
      continue;
    }
    throw new BxlSyntaxError(l0, c0, `unexpected character '${c}'`);
  }
  if (out.length && out[out.length - 1].kind !== "nl") push("nl", "\\n", line, col);
  push("eof", "", line, col);
  return out;
}

/** After `NUMBER%`, decide whether the `%` is the modulo operator (an operand follows). */
function percentIsModulo(src: string, k: number): boolean {
  while (k < src.length && (src[k] === " " || src[k] === "\t")) k++;
  if (k >= src.length) return false;
  const c = src[k];
  if (isDigit(c) || c === "." || c === "(") return true;
  if (isIdStart(c)) {
    let j = k;
    while (j < src.length && isIdChar(src[j])) j++;
    const word = src.slice(k, j);
    // `30% and x`, `5% or`: a keyword follows, so the % belongs to the literal.
    return !KEYWORDS.has(word) || word === "mem" || word === "true" || word === "false" || word === "not";
  }
  return false;
}
