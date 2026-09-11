/**
 * BXL parser: tokens -> AST. Recursive descent; the first syntax error stops
 * parsing and is reported with its line and column. Semantic checks (markets,
 * windows, locals, sizes) happen in codegen so they can all be reported at once.
 *
 * Grammar (newline separated statements, brace blocks):
 *   stmt   := 'let' IDENT '=' expr | IDENT '=' expr | 'mem' '[' expr ']' '=' expr
 *           | 'if' expr block ('elif' expr block | 'else' 'if' expr block)* ('else' block)?
 *           | IDENT '(' args ')'                      (an action)
 *   expr   := or ;  or := and ('or' and)* ;  and := not ('and' not)*
 *   not    := 'not' not | cmp ;  cmp := add (('<'|'<='|'>'|'>='|'=='|'!=') add)?
 *   add    := mul (('+'|'-') mul)* ;  mul := unary (('*'|'/'|'%') unary)*
 *   unary  := '-' unary | primary
 *   primary:= NUMBER | NUMBER% | 'true' | 'false' | IDENT | IDENT '(' args ')' | 'mem' '[' expr ']' | '(' expr ')'
 * `&&`, `||`, `!` are accepted as aliases of `and`, `or`, `not`.
 */
import { BxlSyntaxError, lex, Token } from "./lexer";

export interface Pos {
  line: number;
  col: number;
}

export type BinOp = "+" | "-" | "*" | "/" | "%" | "<" | "<=" | ">" | ">=" | "==" | "!=" | "and" | "or";

export type Expr =
  | { k: "num"; text: string; pct: boolean; pos: Pos }
  | { k: "bool"; value: boolean; pos: Pos }
  | { k: "var"; name: string; pos: Pos }
  | { k: "mem"; index: Expr; pos: Pos }
  | { k: "neg"; e: Expr; pos: Pos }
  | { k: "not"; e: Expr; pos: Pos }
  | { k: "bin"; op: BinOp; a: Expr; b: Expr; pos: Pos }
  | { k: "call"; name: string; args: Expr[]; pos: Pos; end: Pos };

export type Stmt =
  | { k: "let"; name: string; decl: boolean; e: Expr; pos: Pos; namePos: Pos }
  | { k: "memset"; index: Expr; e: Expr; pos: Pos }
  | { k: "if"; arms: { cond: Expr; body: Stmt[]; pos: Pos }[]; els: Stmt[] | null; pos: Pos }
  | { k: "call"; call: Extract<Expr, { k: "call" }>; pos: Pos };

export interface Program {
  body: Stmt[];
}

export { BxlSyntaxError };

const CMP = new Set(["<", "<=", ">", ">=", "==", "!="]);

function describe(t: Token): string {
  if (t.kind === "nl") return t.text === ";" ? "';'" : "end of line";
  if (t.kind === "eof") return "end of input";
  if (t.kind === "num") return `number ${t.text}${t.pct ? "%" : ""}`;
  return `'${t.text}'`;
}

export function parse(src: string): Program {
  const toks = lex(src);
  let p = 0;
  const peek = (o = 0) => toks[Math.min(p + o, toks.length - 1)];
  const next = () => toks[p++];
  const pos = (t: Token): Pos => ({ line: t.line, col: t.col });
  const err = (t: Token, msg: string): never => {
    throw new BxlSyntaxError(t.line, t.col, msg);
  };
  const isOp = (t: Token, ...ops: string[]) => t.kind === "op" && ops.includes(t.text);
  const isKw = (t: Token, ...kws: string[]) => t.kind === "kw" && kws.includes(t.text);
  const expectOp = (op: string, what?: string) => {
    const t = peek();
    if (!isOp(t, op)) err(t, `expected '${op}'${what ? " " + what : ""}, found ${describe(t)}`);
    return next();
  };
  const skipNl = () => {
    while (peek().kind === "nl") p++;
  };

  function program(): Program {
    skipNl();
    const body: Stmt[] = [];
    while (peek().kind !== "eof") {
      if (isOp(peek(), "}")) err(peek(), "unexpected '}' (no block is open)");
      body.push(statement());
      endOfStatement();
      skipNl();
    }
    return { body };
  }

  function endOfStatement() {
    const t = peek();
    if (t.kind === "nl" || t.kind === "eof" || isOp(t, "}")) return;
    err(t, `expected end of line after statement, found ${describe(t)}`);
  }

  function block(owner: string): Stmt[] {
    skipNl();
    const open = peek();
    if (!isOp(open, "{")) err(open, `expected '{' to start the ${owner} block, found ${describe(open)}`);
    next();
    skipNl();
    const body: Stmt[] = [];
    while (!isOp(peek(), "}")) {
      if (peek().kind === "eof") err(open, `unclosed '{' (the ${owner} block opened here is never closed)`);
      body.push(statement());
      endOfStatement();
      skipNl();
    }
    next();
    return body;
  }

  function statement(): Stmt {
    const t = peek();
    if (isKw(t, "let")) {
      next();
      const name = peek();
      if (name.kind !== "ident") err(name, name.kind === "kw" ? `'${name.text}' is a reserved word and cannot be a variable name` : `expected a variable name after 'let', found ${describe(name)}`);
      next();
      expectOp("=", `after 'let ${name.text}'`);
      return { k: "let", name: name.text, decl: true, e: expr(), pos: pos(t), namePos: pos(name) };
    }
    if (isKw(t, "mem")) {
      next();
      expectOp("[", "after 'mem'");
      const index = expr();
      expectOp("]", "to close 'mem['");
      expectOp("=", "to assign to a memory slot");
      return { k: "memset", index, e: expr(), pos: pos(t) };
    }
    if (isKw(t, "if")) return ifStatement();
    if (isKw(t, "elif", "else")) err(t, `'${t.text}' without a matching 'if'`);
    if (t.kind === "ident") {
      if (isOp(peek(1), "=")) {
        next();
        next();
        return { k: "let", name: t.text, decl: false, e: expr(), pos: pos(t), namePos: pos(t) };
      }
      if (isOp(peek(1), "(")) {
        const c = primary();
        if (c.k !== "call") err(t, "expected a statement");
        return { k: "call", call: c as Extract<Expr, { k: "call" }>, pos: pos(t) };
      }
      err(t, `expected '=' or '(' after '${t.text}', found ${describe(peek(1))}`);
    }
    return err(t, `expected a statement (let, if, mem[i] = ..., or an action such as long(SOL, 30%)), found ${describe(t)}`);
  }

  function ifStatement(): Stmt {
    const t = next(); // 'if'
    const arms: { cond: Expr; body: Stmt[]; pos: Pos }[] = [];
    arms.push({ cond: condition("if"), body: block("if"), pos: pos(t) });
    let els: Stmt[] | null = null;
    for (;;) {
      // allow `}` newline `elif` / `else`
      let o = 0;
      while (peek(o).kind === "nl") o++;
      const k = peek(o);
      if (isKw(k, "elif")) {
        p += o;
        const e = next();
        arms.push({ cond: condition("elif"), body: block("elif"), pos: pos(e) });
        continue;
      }
      if (isKw(k, "else")) {
        p += o;
        const e = next();
        if (isKw(peek(), "if")) {
          next();
          arms.push({ cond: condition("else if"), body: block("else if"), pos: pos(e) });
          continue;
        }
        els = block("else");
      }
      break;
    }
    return { k: "if", arms, els, pos: pos(t) };
  }

  function condition(kw: string): Expr {
    const t = peek();
    if (isOp(t, "{") || t.kind === "nl") err(t, `expected a condition after '${kw}'`);
    return expr();
  }

  function expr(): Expr {
    return orExpr();
  }

  function orExpr(): Expr {
    let a = andExpr();
    while (isKw(peek(), "or") || isOp(peek(), "||")) {
      const t = next();
      a = { k: "bin", op: "or", a, b: andExpr(), pos: pos(t) };
    }
    return a;
  }

  function andExpr(): Expr {
    let a = notExpr();
    while (isKw(peek(), "and") || isOp(peek(), "&&")) {
      const t = next();
      a = { k: "bin", op: "and", a, b: notExpr(), pos: pos(t) };
    }
    return a;
  }

  function notExpr(): Expr {
    const t = peek();
    if (isKw(t, "not") || isOp(t, "!")) {
      next();
      return { k: "not", e: notExpr(), pos: pos(t) };
    }
    return cmpExpr();
  }

  function cmpExpr(): Expr {
    const a = addExpr();
    const t = peek();
    if (t.kind === "op" && CMP.has(t.text)) {
      next();
      const b = addExpr();
      const u = peek();
      if (u.kind === "op" && CMP.has(u.text)) err(u, "comparisons cannot be chained; combine them with 'and'");
      return { k: "bin", op: t.text as BinOp, a, b, pos: pos(t) };
    }
    if (isOp(t, "=")) err(t, "unexpected '=' in an expression (use '==' to compare)");
    return a;
  }

  function addExpr(): Expr {
    let a = mulExpr();
    while (isOp(peek(), "+", "-")) {
      const t = next();
      a = { k: "bin", op: t.text as BinOp, a, b: mulExpr(), pos: pos(t) };
    }
    return a;
  }

  function mulExpr(): Expr {
    let a = unary();
    while (isOp(peek(), "*", "/", "%")) {
      const t = next();
      const nt = peek();
      if (t.text === "%" && a.k === "num" && (nt.kind === "nl" || nt.kind === "eof" || isOp(nt, ")", ",", "}"))) {
        err(t, `write percent literals without a space, e.g. ${a.text}%`);
      }
      a = { k: "bin", op: t.text as BinOp, a, b: unary(), pos: pos(t) };
    }
    return a;
  }

  function unary(): Expr {
    const t = peek();
    if (isOp(t, "-")) {
      next();
      return { k: "neg", e: unary(), pos: pos(t) };
    }
    if (isOp(t, "+")) {
      next();
      return unary();
    }
    return primary();
  }

  function primary(): Expr {
    const t = peek();
    if (t.kind === "num") {
      next();
      return { k: "num", text: t.text, pct: !!t.pct, pos: pos(t) };
    }
    if (isKw(t, "true", "false")) {
      next();
      return { k: "bool", value: t.text === "true", pos: pos(t) };
    }
    if (isKw(t, "mem")) {
      next();
      expectOp("[", "after 'mem'");
      const index = expr();
      expectOp("]", "to close 'mem['");
      return { k: "mem", index, pos: pos(t) };
    }
    if (t.kind === "ident") {
      next();
      if (isOp(peek(), "(")) {
        next();
        const args: Expr[] = [];
        if (!isOp(peek(), ")")) {
          for (;;) {
            args.push(expr());
            if (isOp(peek(), ",")) {
              next();
              continue;
            }
            break;
          }
        }
        const close = peek();
        if (!isOp(close, ")")) err(close, `expected ',' or ')' in the arguments of ${t.text}(), found ${describe(close)}`);
        next();
        return { k: "call", name: t.text, args, pos: pos(t), end: pos(close) };
      }
      return { k: "var", name: t.text, pos: pos(t) };
    }
    if (isOp(t, "(")) {
      next();
      const e = expr();
      expectOp(")", "to close '('");
      return e;
    }
    return err(t, `expected an expression, found ${describe(t)}`);
  }

  return program();
}
