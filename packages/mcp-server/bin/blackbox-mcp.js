#!/usr/bin/env node
/**
 * Launcher: registers an in-process TypeScript transpiler (the workspace's
 * `typescript` package, transpile-only, CommonJS) and starts the server from
 * source. No build step and no global ts-node required.
 */
"use strict";
const fs = require("fs");
const path = require("path");

function registerTs() {
  if (require.extensions[".ts"]) return; // ts-node or similar already active
  let ts;
  try {
    ts = require("typescript");
  } catch {
    ts = require(require.resolve("typescript", { paths: [path.resolve(__dirname, "../../..")] }));
  }
  const compilerOptions = {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
    resolveJsonModule: true,
    inlineSourceMap: true,
  };
  require.extensions[".ts"] = function (module, filename) {
    const src = fs.readFileSync(filename, "utf8");
    const out = ts.transpileModule(src, { compilerOptions, fileName: filename, reportDiagnostics: false });
    module._compile(out.outputText, filename);
  };
}

registerTs();
require("../src/index.ts")
  .main(process.argv.slice(2))
  .catch((e) => {
    process.stderr.write(`[blackbox-mcp] fatal: ${(e && e.stack) || e}\n`);
    process.exit(1);
  });
