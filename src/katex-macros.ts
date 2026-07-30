// Global KaTeX macro environment.
//
// The actual definitions live as `.tex` files under `etc/katex-macros/` in the
// Emacs config; the Node server parses them (via shared/katex-macros.mjs) and
// hands the resulting map to the browser, which installs it here before the first
// note renders. `math-render.ts` reads the active map + version on every render
// and folds the version into its HTML cache key.

import { parseLatexMacros } from "../shared/katex-macros.mjs";

export { parseLatexMacros };

export type KatexMacroMap = Record<string, string>;

let activeMacros: KatexMacroMap = {};
let activeVersion = "0";

// FNV-1a over the sorted entries; stable across runs so the math cache key only
// changes when the macro set actually changes.
function hashMacros(map: KatexMacroMap): string {
  const keys = Object.keys(map).sort();
  let h = 0x811c9dc5;
  const str = keys.map((k) => `${k}=${map[k]}`).join("");
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${(h >>> 0).toString(36)}.${keys.length}`;
}

export function setKatexMacros(map: KatexMacroMap | null | undefined): void {
  activeMacros = { ...(map ?? {}) };
  activeVersion = Object.keys(activeMacros).length === 0 ? "0" : hashMacros(activeMacros);
}

export function getKatexMacros(): KatexMacroMap {
  return activeMacros;
}

export function getKatexMacrosVersion(): string {
  return activeVersion;
}
