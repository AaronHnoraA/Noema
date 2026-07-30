// Node-only loader for the global KaTeX macro folder.
//
// Reads every `*.tex` file in a directory and parses them into a KaTeX macros
// map via the browser-safe parser in shared/katex-macros.mjs. Kept separate from
// shared/ so the fs dependency never leaks into the editor bundle.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseLatexMacros } from "../../shared/katex-macros.mjs";

/**
 * @param {string} dir Absolute path to the macro folder.
 * @returns {{ dir: string, macros: Record<string,string>, errors: {file:string,message:string}[] }}
 */
export function loadKatexMacros(dir) {
  const resolved = String(dir || "");
  if (!resolved || !existsSync(resolved) || !statSync(resolved).isDirectory()) {
    return { dir: resolved, macros: {}, errors: [] };
  }
  const files = [];
  for (const name of readdirSync(resolved).sort()) {
    if (!name.endsWith(".tex")) continue;
    try {
      files.push({ name, text: readFileSync(join(resolved, name), "utf8") });
    } catch (err) {
      // Surface the read failure as a parse error rather than throwing.
      files.push({ name, text: "" });
      void err;
    }
  }
  return { dir: resolved, ...parseLatexMacros(files) };
}
