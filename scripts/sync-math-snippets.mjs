#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import katex from "katex";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const outputRoot = join(repoRoot, "resources", "snippets", "tex-mode", "generated");
const manifestFile = join(outputRoot, ".manifest.json");

const SOURCES = {
  "latex-workshop": {
    revision: "57f9e8d0306ea0c7419290a2b62ee0cec3c31041",
    repository: "https://github.com/James-Yu/LaTeX-Workshop",
    license: "MIT",
  },
  overleaf: {
    revision: "28ad3b03b71cb4311decdcb55c36b33ec10d72db",
    repository: "https://github.com/overleaf/overleaf",
    license: "AGPL-3.0",
  },
};

const MATH_ENVIRONMENTS = new Set([
  "align", "align*", "aligned", "alignedat", "array", "Bmatrix", "bmatrix", "cases",
  "equation", "equation*", "gather", "gather*", "gathered", "matrix", "multline",
  "multline*", "pmatrix", "smallmatrix", "split", "Vmatrix", "vmatrix",
]);
const FORBIDDEN_COMMAND_RE = /\\(?:begin|end|usepackage|documentclass|section|subsection|chapter|cite|label|ref|include|input|bibliography|includegraphics|item)\b/;

function args() {
  const values = process.argv.slice(2);
  const take = (flag) => {
    const index = values.indexOf(flag);
    return index < 0 ? "" : values[index + 1] || "";
  };
  return {
    write: values.includes("--write"),
    check: values.includes("--check") || !values.includes("--write"),
    latexGit: take("--latex-workshop-git") || process.env.AARONNOTE_LATEX_WORKSHOP_GIT || "",
    overleafGit: take("--overleaf-git") || process.env.AARONNOTE_OVERLEAF_GIT || "",
  };
}

function gitShow(root, revision, file) {
  if (!root || !existsSync(root)) throw new Error(`Missing upstream git checkout for ${file}`);
  return execFileSync("git", ["-C", root, "show", `${revision}:${file}`], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function selectedTextYas(fallback = "") {
  const escaped = String(fallback).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `\`(or yas-selected-text "${escaped}")\``;
}

function textmateToYas(body) {
  return String(body || "")
    .replace(/\$\{TM_SELECTED_TEXT(?::([^}]*))?\}/g, (_whole, fallback) => selectedTextYas(fallback || ""))
    .replace(/\$TM_SELECTED_TEXT\b/g, selectedTextYas(""));
}

function safeFileName(key, fallback) {
  const slug = String(key || fallback).replace(/^\\/, "cmd-").replace(/^@/, "at-")
    .replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 72).toLowerCase();
  return slug || `snippet-${sha256(String(fallback)).slice(0, 10)}`;
}

function katexCompatible(body) {
  if (!body || FORBIDDEN_COMMAND_RE.test(body)) return false;
  const sample = body
    .replace(/\$0/g, "")
    .replace(/\$\{\d+(?::[^}]*)?\}/g, "x")
    .replace(/\$\d+/g, "x")
    .replace(/`[^`]*`/g, "x")
    .replace(/\\begin\{([^}]+)\}[\s\S]*?\\end\{\1\}/g, "x");
  try {
    katex.renderToString(sample || "x", { throwOnError: true, strict: "ignore", displayMode: false });
    return true;
  } catch {
    return false;
  }
}

function normalizeSnippet({ key, name, description, body, provider, weight = 0, context = "math" }) {
  const yasBody = textmateToYas(body);
  if (!key || !yasBody || !katexCompatible(yasBody)) return null;
  return {
    id: `${provider}:${key}`,
    key,
    name: name || key,
    description: description || "",
    body: yasBody,
    provider,
    priority: provider === "latex-workshop" ? 180 : 160,
    weight: Number(weight) || 0,
    context,
  };
}

function latexWorkshopSnippets(root, inputs) {
  const source = SOURCES["latex-workshop"];
  const atText = gitShow(root, source.revision, "data/at-suggestions.json");
  const snippetText = gitShow(root, source.revision, "data/latex-snippet.json");
  const commandText = gitShow(root, source.revision, "data/commands.json");
  inputs.push({ provider: "latex-workshop", file: "data/at-suggestions.json", sha256: sha256(atText) });
  inputs.push({ provider: "latex-workshop", file: "data/latex-snippet.json", sha256: sha256(snippetText) });
  inputs.push({ provider: "latex-workshop", file: "data/commands.json", sha256: sha256(commandText) });

  const out = [];
  for (const [name, value] of Object.entries(JSON.parse(atText))) {
    out.push(normalizeSnippet({ key: value.prefix, name, description: value.description, body: value.body, provider: "latex-workshop", context: "math-at" }));
  }
  for (const [name, value] of Object.entries(JSON.parse(snippetText))) {
    const environment = String(value.body || "").match(/^\\begin\{([^}]+)\}/)?.[1];
    const mathStyle = /^(?:subscript|superscript|etc|mathrm|mathsf|mathbf|mathbb|mathcal|mathit|mathtt)$/.test(name);
    if (!mathStyle && (!environment || !MATH_ENVIRONMENTS.has(environment))) continue;
    out.push(normalizeSnippet({ key: value.prefix, name, description: value.description, body: value.body, provider: "latex-workshop" }));
  }
  for (const [command, value] of Object.entries(JSON.parse(commandText))) {
    if (["begin", "end"].includes(command) || FORBIDDEN_COMMAND_RE.test(`\\${command}`)) continue;
    const body = `\\${String(value.snippet || command).replace(/^\\/, "")}$0`;
    out.push(normalizeSnippet({ key: `\\${command}`, name: `\\${command}`, description: value.detail || value.documentation, body, provider: "latex-workshop", context: "math-command" }));
  }
  return out.filter(Boolean);
}

function decodeTsString(value) {
  return value.replace(/\\'/g, "'").replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\\\/g, "\\");
}

function overleafProperty(block, name) {
  const match = block.match(new RegExp(`${name}:\\s*'((?:\\\\.|[^'])*)'`));
  return match ? decodeTsString(match[1]) : "";
}

function overleafSnippets(root, inputs) {
  const source = SOURCES.overleaf;
  const file = "services/web/frontend/js/features/source-editor/languages/latex/completions/data/top-hundred-snippets.ts";
  const text = gitShow(root, source.revision, file);
  inputs.push({ provider: "overleaf", file, sha256: sha256(text) });
  const out = [];
  for (const match of text.matchAll(/\{([\s\S]*?)\},/g)) {
    const block = match[1];
    const caption = overleafProperty(block, "caption");
    const body = overleafProperty(block, "snippet");
    const meta = overleafProperty(block, "meta");
    const weight = Number(block.match(/score:\s*([0-9.]+)/)?.[1] || 0);
    const command = caption.match(/^\\[A-Za-z]+/)?.[0] || "";
    const environment = body.match(/^\\begin\{([^}]+)\}/)?.[1];
    if (meta === "env" && (!environment || !MATH_ENVIRONMENTS.has(environment))) continue;
    if (meta !== "env" && (!command || FORBIDDEN_COMMAND_RE.test(command))) continue;
    out.push(normalizeSnippet({ key: command || `env-${environment}`, name: caption, description: `Overleaf ${meta}`, body: `${body}$0`, provider: "overleaf", weight, context: "math-command" }));
  }
  return out.filter(Boolean);
}

function deDuplicate(snippets) {
  const byId = new Map();
  for (const snippet of snippets) {
    const identity = `${snippet.provider}\0${snippet.key}`;
    const previous = byId.get(identity);
    if (!previous || snippet.weight > previous.weight) byId.set(identity, snippet);
  }
  return [...byId.values()].sort((a, b) => a.provider.localeCompare(b.provider) || a.key.localeCompare(b.key));
}

function renderYas(snippet) {
  const metadata = new URLSearchParams({
    provider: snippet.provider,
    priority: String(snippet.priority),
    weight: String(snippet.weight),
    context: snippet.context,
    description: snippet.description.replace(/\r?\n/g, " "),
  });
  return [
    "# -*- mode: snippet -*-",
    `# name: ${snippet.name.replace(/\r?\n/g, " ")}`,
    `# key: ${snippet.key}`,
    // YAS defaults identity to # name; provider-scoped UUIDs prevent two
    // upstreams with the same display name from replacing one another.
    `# uuid: ${snippet.id}`,
    // contributor is a native YAS header. The encoded suffix carries browser
    // ranking metadata without making YAS log hundreds of unknown directives.
    `# contributor: Noema ${metadata.toString()}`,
    `# group: Math · ${snippet.provider}`,
    "# --",
    snippet.body,
    "",
  ].join("\n");
}

async function expectedFiles(snippets) {
  const files = new Map();
  const used = new Set();
  for (const snippet of snippets) {
    let base = safeFileName(snippet.key, snippet.id);
    let relative = `${snippet.provider}/${base}`;
    if (used.has(relative)) relative = `${snippet.provider}/${base}-${sha256(snippet.id).slice(0, 8)}`;
    used.add(relative);
    files.set(relative, renderYas(snippet));
  }
  return files;
}

async function listGeneratedFiles() {
  const files = [];
  for (const provider of Object.keys(SOURCES)) {
    const dir = join(outputRoot, provider);
    if (!existsSync(dir)) continue;
    for (const name of await readdir(dir)) files.push(`${provider}/${name}`);
  }
  return files.sort();
}

async function verifyManifest() {
  if (!existsSync(manifestFile)) throw new Error("Generated snippet manifest is missing; run snippets:sync -- --write with upstream checkouts");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  const actual = await listGeneratedFiles();
  const expected = Object.keys(manifest.files || {}).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("Generated snippet file list differs from the manifest");
  for (const relative of expected) {
    const text = await readFile(join(outputRoot, relative), "utf8");
    if (sha256(text) !== manifest.files[relative]) throw new Error(`Generated snippet changed: ${relative}`);
  }
  console.log(`snippet sync check: ${expected.length} generated files verified`);
}

async function main() {
  const options = args();
  if (options.check && !options.write) return verifyManifest();
  const inputs = [];
  const snippets = deDuplicate([
    ...latexWorkshopSnippets(options.latexGit, inputs),
    ...overleafSnippets(options.overleafGit, inputs),
  ]);
  const files = await expectedFiles(snippets);
  await mkdir(outputRoot, { recursive: true });
  const existing = await listGeneratedFiles();
  for (const relative of existing) {
    if (!files.has(relative)) await unlink(join(outputRoot, relative));
  }
  for (const [relative, text] of files) {
    const file = join(outputRoot, relative);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, text, "utf8");
  }
  const manifest = {
    schemaVersion: 1,
    generatedAt: "deterministic-from-pinned-revisions",
    sources: SOURCES,
    inputs,
    imported: snippets.length,
    importedByProvider: Object.fromEntries(Object.keys(SOURCES).map((provider) => [
      provider,
      snippets.filter((snippet) => snippet.provider === provider).length,
    ])),
    files: Object.fromEntries([...files].map(([relative, text]) => [relative, sha256(text)])),
  };
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`snippet sync write: ${snippets.length} math snippets (${Object.entries(manifest.importedByProvider).map(([key, value]) => `${key}=${value}`).join(", ")})`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
