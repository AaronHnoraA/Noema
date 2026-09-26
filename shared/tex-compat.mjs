// TeX compatibility rules shared by every renderer.
//
// KaTeX (browser, export) and RaTeX (the Emacs preview) implement the same
// subset of LaTeX, so they need the same handful of rewrites for amsmath and
// plain-TeX constructs neither implements. Keeping the rules in one JSON file
// is what stops the editor preview and the published note from disagreeing.
//
// MUST stay free of any node:* imports so it can be bundled for the editor.

import rules from "./tex-compat-rules.json" with { type: "json" };

/** Environments rewritten to a supported equivalent: name -> replacement. */
export const COMPAT_ENVIRONMENTS = Object.freeze({ ...rules.environments });

/** Macro definitions injected into the renderer: name -> body. */
export const COMPAT_MACROS = Object.freeze({ ...rules.macros });

function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Rewrite every `\begin{X}`/`\end{X}` listed in COMPAT_ENVIRONMENTS. */
export function rewriteCompatEnvironments(source) {
  let out = String(source ?? "");
  for (const [from, to] of Object.entries(COMPAT_ENVIRONMENTS)) {
    const name = escapeForRegExp(from);
    out = out
      .replace(new RegExp(`\\\\begin\\{${name}\\}`, "g"), `\\begin{${to}}`)
      .replace(new RegExp(`\\\\end\\{${name}\\}`, "g"), `\\end{${to}}`);
  }
  return out;
}
