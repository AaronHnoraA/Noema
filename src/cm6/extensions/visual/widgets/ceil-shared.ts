/**
 * Shared @@cell ("ceil") identity + language helpers.
 *
 * The block widget (block-extras.ts) and the app-shell Jupyter panel
 * (aaronnote/main.ts) both parse `@@cell(...) [id]` lines. They must agree on
 * the auto-generated id for an unlabeled cell and on the kernel→language
 * mapping, otherwise a panel-driven run writes to a different hidden-script
 * marker than the widget's normalized id. Keep this the single source of truth.
 */

import { shortHash } from "./measured-observer.ts";

// from = source offset of the `@@cell` token (after leading whitespace).
export function ceilCommandGeneratedId(file: string, from: number, argsRaw: string, idRaw: string): string {
  return `ceil-${shortHash(`${file}\n${from}\n${argsRaw}\n${idRaw}`)}`;
}

export function ceilLanguageForKernel(kernel: string, requested = ""): string {
  const explicit = String(requested || "").trim().toLowerCase();
  const value = String(kernel || "").toLowerCase();
  if (value.includes("lean") || explicit === "lean" || explicit === "lean4") return "lean4";
  if (["bash", "sh", "shell", "zsh"].includes(explicit)) return "bash";
  if (explicit) return explicit;
  if (value.includes("sage")) return "python";
  if (value.includes("python") || value === "py" || value === "python3") return "python";
  if (value.includes("julia")) return "julia";
  if (value === "r" || value.startsWith("ir")) return "r";
  if (value.includes("bash") || value.includes("zsh") || value.includes("shell")) return "bash";
  if (value.includes("typescript") || value === "ts") return "typescript";
  if (value.includes("javascript") || value === "js" || value.includes("node")) return "javascript";
  return "python";
}
