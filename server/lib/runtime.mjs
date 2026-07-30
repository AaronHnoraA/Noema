import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { changedRoamFilesSince, commitRoam, fileHistory, restoreFileFromCommit, discardFileChanges, roamRepoStatus, roamRepoChanges, diffRoamFile, diffRoamCommit, pullRoam, pushRoam, repoHistory, headSha } from "./roam-git.mjs";
import { configureTmpRoot, aaronnoteTmpRoot, runtimeMkdtemp, runtimeTmpFile } from "./tmp.mjs";
import { applyLatexTemplate, bibliographyReferencesToLatex, defaultLatexOutputPath, escapeLatexText, escapeLatexTitle, escapeLatexUrl, latexMacrosPackage, readLatexTemplate, writeLatexExport } from "./latex-export.mjs";
import { aaronnoteMarkdownToLatexPandoc, extractAaronnoteMetadata } from "./latex-export-pandoc.mjs";
import { agentAvailable, loadAgentRules, normalizeAgentTitle, polishBodyWithAgent } from "./latex-export-codex.mjs";
import { loadKatexMacros } from "./katex-macros.mjs";
import { durationFromEnv } from "./jupyter-cell.mjs";
import { maskMetaSummaryContent } from "../../shared/meta-summary.mjs";
import { SessionManager } from "../Features/Session/manager.mjs";
import {
  bibliographyCompletions,
  bibliographyForDocument,
  bibliographyPathWatchRelevant,
  bibliographyVersion,
  clearBibliographyCache,
  configureBibliography,
} from "./bibliography.mjs";
import { parseCommandArgs, scanInlineCommands } from "../../shared/command-syntax.mjs";
import {
  patchPlanningNodeRaw,
  scanPlanningNodes,
  serializeInlineAttrs,
} from "../../shared/planning-dsl.mjs";
import {
  DATE_KEYS,
  TODO_KEY_ALIASES,
  applyRepeater,
  canonicalTodoArgs,
  formatDateValue,
  formatDuration,
  midnightMs,
  normalizeDateValue,
  normalizeTodoStatus,
  parseDateValue,
  parseDepRefs,
  parseDuration,
  parseLeadTime,
  parseRepeater,
  shiftDate,
  todoArgKeyForCanonical,
} from "../../shared/planning-values.mjs";

export { parseCommandArgs, scanInlineCommands, scanPlanningNodes };
export {
  applyRepeater,
  canonicalTodoArgs,
  formatDateValue,
  formatDuration,
  normalizeDateValue,
  normalizeTodoStatus,
  parseDateValue,
  parseDepRefs,
  parseDuration,
  parseLeadTime,
  parseRepeater,
  todoArgKeyForCanonical,
};

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
let workspaceRoot = resolve(process.env.AARONNOTE_WORKSPACE_ROOT || resolve(appDir, ".."));
let publishJsDir = resolve(process.env.AARONNOTE_PUBLISH_JS_DIR || join(workspaceRoot, "js"));
let stateRoot = resolve(process.env.AARONNOTE_STATE_DIR || join(workspaceRoot, "var", "aaronnote"));
let runtimeTmpRoot = configureTmpRoot(process.env.AARONNOTE_TMP_DIR || join(stateRoot, "tmp"));
let snippetsRoot = resolve(process.env.AARONNOTE_SNIPPETS_ROOT || join(workspaceRoot, "snippets"));
let templatesRoot = resolve(process.env.AARONNOTE_TEMPLATES_ROOT || join(workspaceRoot, "templates", "noema"));
let latexTemplatesRoot = resolve(process.env.AARONNOTE_LATEX_TEMPLATES_ROOT || join(workspaceRoot, "templates"));
let katexMacrosRoot = resolve(process.env.AARONNOTE_KATEX_MACROS_DIR || join(workspaceRoot, "etc", "katex-macros"));
// LaTeX export engine (mechanical base + optional codex polish). See
// server/lib/latex-export-codex.mjs and docs/latex-export-style.md.
let latexAgentDir = resolve(process.env.AARONNOTE_LATEX_AGENT_DIR || join(appDir, "agents", "latex-export"));
let latexExportEngine = String(process.env.AARONNOTE_LATEX_EXPORT_ENGINE || "codex").trim().toLowerCase();
let latexExportAgent = String(process.env.AARONNOTE_LATEX_EXPORT_AGENT || "codex").trim().toLowerCase();
let latexCodexBin = String(process.env.AARONNOTE_CODEX_BIN || "codex").trim();
let latexClaudeBin = String(process.env.AARONNOTE_CLAUDE_BIN || "claude").trim();
let latexOpencodeBin = String(process.env.AARONNOTE_OPENCODE_BIN || "opencode").trim();
let latexCodexModel = String(process.env.AARONNOTE_CODEX_MODEL || "").trim();
let latexExportModel = String(process.env.AARONNOTE_LATEX_EXPORT_MODEL || "").trim();
let latexExportMaxAttempts = Math.max(1, Number(process.env.AARONNOTE_LATEX_EXPORT_MAX_ATTEMPTS) || 3);
let latexExportAgentIdleTimeoutMs = Math.max(10_000, Number(process.env.AARONNOTE_LATEX_EXPORT_AGENT_IDLE_TIMEOUT_MS) || 180_000);
let latexExportAgentHardTimeoutMs = Math.max(latexExportAgentIdleTimeoutMs, Number(process.env.AARONNOTE_LATEX_EXPORT_AGENT_HARD_TIMEOUT_MS) || 900_000);
const LATEX_EXPORT_AGENTS = ["codex", "claude", "opencode"];
const LATEX_EXPORT_ENGINES = ["codex", "mechanical"];
const execFileAsync = promisify(execFile);

let noteRoot = resolveUserPath(process.env.AARONNOTE_ROOT || join(appDir, "..", "roam"));
configureBibliography({ root: noteRoot });
let noteScanRoot = noteRoot;
const excludedDirs = new Set([
  "_typst",
  "public",
  "var",
  ".git",
  ".lake",
  ".direnv",
  ".venv",
  "node_modules",
  "__pycache__",
  ".ipynb_checkpoints",
  ".jupyter",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".virtual_documents",
]);
const generatedAttachmentDirs = new Set(["asset", "assets", "attachment", "attachments", "file", "files", "img", "imgs", "image", "images", "media", "pdf", "pdfs"]);
const noteExts = new Set([".typ", ".md", ".markdown"]);
const projectRootMarkers = [
  ".git",
  ".project",
  ".projectile",
  ".root",
  "AGENT.md",
  "CLAUDE.md",
  "Makefile",
  "CMakeLists.txt",
  "Cargo.toml",
  "go.mod",
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "pom.xml",
  "build.gradle",
  "settings.gradle",
  "flake.nix",
  "dune-project",
  "mix.exs",
  "Gemfile",
];
const defaultNoteKind = "default";
const defaultNoteKindAliases = new Set(["", "default", "note"]);
const noteKindPattern = /^[a-z0-9_-]+$/;
const refTokenPattern = /#note\("([^"]+)"\)|\broam:\/\/[^\s<>)\]]+/gi;
let noteCacheRoot = "";
let noteCache = new Map();
let notesSnapshotRoot = "";
let notesSnapshot = null;
let notesRawSnapshot = null;
let notesRelationshipCache = null;
let notesSnapshotDirty = true;
let notesSnapshotFullDirty = true;
let dirtyNoteFiles = new Set();
let externalFileProvider = null;
let snippetCache = { key: "", scannedAt: 0, snippets: [] };
let templateCache = { key: "", scannedAt: 0, templates: [] };
let copilotClient = null;
let copilotLog = [];
let copilotLogRecording = false;
let roamSyncTimer = null;
let roamSyncInFlight = null;
let queuedRoamSyncNotes = null;
let queuedRoamSyncChangedFiles = new Set();
let agendaPersistentCache = null;
let agendaPersistentCacheKey = "";
let agendaPersistentCacheDirty = false;
let agendaPersistentCacheLoad = null;
let notesSnapshotFingerprint = "";
let atomicWriteCounter = 0;
const noteCodeFileCache = new Map();
const noteCodeFilePending = new Map();
let noteCodeFileCacheBytes = 0;
const pathSuggestionDirListingCache = new Map();
const contentRootCache = new Map();
const AGENDA_CACHE_SCHEMA = 1;
const AGENDA_PAYLOAD_CACHE_LIMIT = 32;
const CURRENT_DB_SCHEMA = 1;
const ASSET_CLEANUP_SCHEMA = 2;
const ROAM_FULL_SYNC_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
// Autosave is debounced at 650 ms in the client.  Even at the impossible
// ceiling of one successful write every 650 ms for 24 hours, this sample rate
// yields 2.66 automatic drains/day in expectation.  Real writing produces far
// fewer saves.  A miss only leaves the already-deduplicated Set queue intact.
const ROAM_SAVE_SYNC_SAMPLE_RATE = 1 / 50_000;
const scanConcurrency = Math.max(1, Math.min(64, Number(process.env.AARONNOTE_SCAN_CONCURRENCY) || 16));
const saveRequestVersions = new Map();
const saveWriteQueues = new Map();
let clockMutationQueue = Promise.resolve();
let sessionManager = null;
const NOTE_CODE_FILE_CACHE_LIMIT = 64;
const NOTE_CODE_FILE_CACHE_BYTES = 8_000_000;
const PATH_SUGGESTION_DIR_CACHE_LIMIT = 64;
const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "application/javascript; charset=utf-8"],
  [".mjs", "application/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".avif", "image/avif"],
  [".bmp", "image/bmp"],
  [".pdf", "application/pdf"],
  [".txt", "text/plain; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
  [".markdown", "text/markdown; charset=utf-8"],
  [".lean", "text/x-lean4; charset=utf-8"],
  [".drawio", "application/vnd.jgraph.mxfile"],
  [".dio", "application/vnd.jgraph.mxfile"],
  [".mp3", "audio/mpeg"],
  [".mp4", "video/mp4"],
  [".mov", "video/quicktime"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"],
  [".wasm", "application/wasm"],
]);
const pathSuggestionCodeExts = new Set([
  ".bash",
  ".c",
  ".cpp",
  ".csv",
  ".go",
  ".ipynb",
  ".jl",
  ".js",
  ".json",
  ".jsx",
  ".lua",
  ".m",
  ".py",
  ".qmd",
  ".r",
  ".rmd",
  ".rs",
  ".sh",
  ".ts",
  ".tsx",
  ".zsh",
]);
async function atomicWriteFile(file, data, options) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = await runtimeTmpFile("save", file, `.tmp-${process.pid}-${Date.now()}-${++atomicWriteCounter}`);
  try {
    await writeFile(tmp, data, options);
    try {
      await rename(tmp, file);
    } catch (err) {
      if (err?.code !== "EXDEV") throw err;
      await copyFile(tmp, file);
      await rm(tmp, { force: true }).catch(() => {});
    }
    noteSelfWrite(file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

function canonicalExistingPath(path) {
  const resolved = resolve(String(path || ""));
  let probe = resolved;
  const missingParts = [];
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) return resolved;
    missingParts.unshift(basename(probe));
    probe = parent;
  }
  try {
    const real = realpathSync.native(probe);
    return missingParts.length ? join(real, ...missingParts) : real;
  } catch {
    return resolved;
  }
}

function relativeInsideP(rel) {
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function inside(child, parent) {
  const rel = relative(parent, child);
  if (relativeInsideP(rel)) return true;
  return relativeInsideP(relative(canonicalExistingPath(parent), canonicalExistingPath(child)));
}

function relativeCanonical(parent, child) {
  const rel = relative(parent, child);
  if (relativeInsideP(rel)) return rel;
  return relative(canonicalExistingPath(parent), canonicalExistingPath(child));
}

function expandUserPath(input) {
  const raw = String(input || "");
  if (raw === "~") return homedir();
  if (/^~[\\/]/.test(raw)) return join(homedir(), raw.slice(2));
  return raw;
}

function resolveUserPath(input) {
  return resolve(expandUserPath(input));
}

function slashPath(path) {
  return String(path || "").split(sep).join("/");
}

function displayPathForFile(file, root = noteScanRoot) {
  if (inside(file, noteRoot)) return slashPath(relativeCanonical(noteRoot, file));
  const home = homedir();
  if (inside(file, home)) {
    const rel = slashPath(relativeCanonical(home, file));
    return rel ? `~/${rel}` : "~";
  }
  if (root && inside(file, root)) return slashPath(relativeCanonical(root, file));
  return slashPath(file);
}

function displayPathForScanRoot(file, root = noteScanRoot) {
  if (root && inside(file, root)) {
    const rel = slashPath(relativeCanonical(root, file));
    return rel || "";
  }
  return displayPathForFile(file, root);
}

function scanRootForOpenFile(file) {
  return standaloneFile(file) ? dirname(file) : noteRoot;
}

function safeFile(input) {
  const file = resolveUserPath(input);
  if (!inside(file, noteRoot)) {
    const err = new Error(`File is outside note root: ${file}`);
    err.statusCode = 403;
    throw err;
  }
  return file;
}

function standaloneMarkdownFile(file) {
  return /\.(?:md|markdown)$/i.test(file);
}

function leanSourceFile(file) {
  return /\.lean$/i.test(String(file || ""));
}

function safeOpenFile(input) {
  const file = resolveUserPath(input);
  if (inside(file, noteRoot)) return file;
  if (standaloneMarkdownFile(file)) return file;
  const err = new Error(`File is outside note root: ${file}`);
  err.statusCode = 403;
  throw err;
}

function standaloneFile(file) {
  return !inside(file, noteRoot);
}

function markerProjectRoot(startDir) {
  const start = resolveUserPath(startDir || "");
  const cached = contentRootCache.get(start);
  if (cached) return cached;
  let dir = start;
  let root = "";
  for (let depth = 0; depth < 32; depth++) {
    if (projectRootMarkers.some((marker) => existsSync(join(dir, marker)))) {
      root = dir;
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (!root) {
    const parent = dirname(start);
    root = parent === start ? start : parent;
  }
  contentRootCache.set(start, root);
  if (contentRootCache.size > 512) contentRootCache.clear();
  return root;
}

function contentRootForFile(file) {
  if (!file || !standaloneFile(file)) return noteRoot;
  return markerProjectRoot(dirname(file));
}

function cleanContentPath(input) {
  let raw = String(input || "").trim();
  if (raw.startsWith("<") && raw.endsWith(">")) raw = raw.slice(1, -1).trim();
  return raw.split(/[?#]/, 1)[0].trim();
}

function roamPrefixedPath(raw) {
  const clean = String(raw || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (clean === "roam") return "";
  return clean.startsWith("roam/") ? clean.slice("roam/".length) : null;
}

export function resolveContentFile(input, base = "") {
  const raw = cleanContentPath(input);
  if (!raw) {
    const err = new Error("Missing content file");
    err.statusCode = 400;
    throw err;
  }
  const baseFile = base ? safeOpenFile(base) : "";
  const baseDir = baseFile ? dirname(baseFile) : noteRoot;
  const logicalRoot = contentRootForFile(baseFile);
  let file = "";
  const roamPath = roamPrefixedPath(raw);
  if (/^file:\/\//i.test(raw)) {
    try {
      file = fileURLToPath(raw);
    } catch {
      file = resolveUserPath(raw.replace(/^file:\/\//i, ""));
    }
  } else if (/^file:/i.test(raw)) {
    file = resolveUserPath(raw.replace(/^file:/i, ""));
  } else if (/^~(?:$|[\\/])/.test(raw)) {
    file = resolveUserPath(raw);
  } else if (roamPath != null) {
    file = resolve(noteRoot, roamPath);
  } else if (raw.startsWith("/")) {
    file = baseFile ? resolve(logicalRoot, raw.replace(/^\/+/, "")) : resolve(raw);
  } else {
    file = resolve(baseDir, raw);
  }
  if (!inside(file, noteRoot) && !inside(file, logicalRoot)) {
    const err = new Error(`Content file is outside the allowed root: ${file}`);
    err.statusCode = 403;
    throw err;
  }
  return file;
}

async function deleteManagedLeanMirror(_file, _info) {}

async function renameManagedLeanMirror(_file, _target, _info) {}

async function copyManagedLeanMirror(_file, _target, _info) {}

export function fileContentType(file) {
  if (/\.drawio\.xml$/i.test(String(file || ""))) return "application/vnd.jgraph.mxfile";
  return contentTypes.get(extname(file).toLowerCase()) || "application/octet-stream";
}

function sanitizeAssetName(input, fallback = "attachment") {
  const raw = basename(String(input || fallback)).normalize("NFKC");
  const safe = raw
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, "-")
    .replace(/\s+/g, "-")
    .trim()
    .replace(/^\.+$/, "");
  return safe || fallback;
}

function imageAssetP(name, type = "") {
  if (String(type).toLowerCase().startsWith("image/")) return true;
  return new Set([".avif", ".bmp", ".gif", ".jpeg", ".jpg", ".png", ".svg", ".webp"])
    .has(extname(name).toLowerCase());
}

function visualAssetP(name, type = "") {
  const lowerType = String(type || "").toLowerCase();
  if (lowerType.includes("jgraph") || lowerType.includes("drawio") || lowerType === "text/html" || lowerType.startsWith("text/html;")) return true;
  const lowerName = String(name || "").toLowerCase();
  return /\.(?:drawio|dio)(?:\.xml)?$/i.test(lowerName) || /\.html?$/i.test(lowerName);
}

async function uniqueAssetPath(dir, name) {
  const ext = extname(name);
  const stem = basename(name, ext) || "attachment";
  let candidate = join(dir, name);
  for (let i = 2; existsSync(candidate); i++) {
    candidate = join(dir, `${stem}-${i}${ext}`);
  }
  return candidate;
}

function markdownRelativePath(fromFile, targetFile) {
  const fromDir = fromFile ? dirname(safeOpenFile(fromFile)) : noteRoot;
  let rel = relativeCanonical(fromDir, targetFile).split(sep).join("/");
  if (!rel.startsWith(".") && !rel.startsWith("/")) rel = `./${rel}`;
  return rel;
}

function resolveInputPath(input, root) {
  const raw = String(input || "");
  if (/^~(?:$|[\\/])/.test(raw) || isAbsolute(raw)) return resolveUserPath(raw);
  return resolve(root, raw);
}

function resolveInternalContentPath(input, baseDir, allowedRoot = noteRoot) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  let file = "";
  const roamPath = roamPrefixedPath(raw);
  if (/^file:\/\//i.test(raw)) {
    try {
      file = fileURLToPath(raw);
    } catch {
      file = resolveUserPath(raw.replace(/^file:\/\//i, ""));
    }
  } else if (/^file:/i.test(raw)) {
    file = resolveUserPath(raw.replace(/^file:/i, ""));
  } else if (/^~(?:$|[\\/])/.test(raw)) {
    file = resolveUserPath(raw);
  } else if (roamPath != null) {
    file = resolve(noteRoot, roamPath);
  } else if (raw.startsWith("/")) {
    file = resolve(allowedRoot, raw.replace(/^\/+/, ""));
  } else {
    file = resolve(baseDir, raw);
  }
  if (!inside(file, noteRoot) && !inside(file, allowedRoot)) return "";
  return file;
}

function bareRelativeContentPath(input) {
  const raw = String(input || "").trim();
  if (!raw || raw.startsWith(".") || raw.startsWith("/") || /^file:/i.test(raw) || /^~(?:$|[\\/])/.test(raw)) return false;
  return roamPrefixedPath(raw) == null;
}

function resolveNoteCodePath(input, baseDir, allowedRoot = noteRoot) {
  const file = resolveInternalContentPath(input, baseDir, allowedRoot);
  if (!file || !bareRelativeContentPath(input) || existsSync(file)) return file;
  const rootFile = resolve(allowedRoot, String(input || "").trim());
  if (inside(rootFile, allowedRoot) && existsSync(rootFile)) return rootFile;
  return file;
}

function assetFolderName(current) {
  if (!current) return "scratch";
  const ext = extname(current);
  return sanitizeAssetName(basename(current, ext), "note");
}

function standaloneAssetRoot(file) {
  return contentRootForFile(file);
}

export function resolveMediaFile(file, base = "") {
  const raw = String(file || "");
  if (!raw) {
    const err = new Error("Missing media file");
    err.statusCode = 400;
    throw err;
  }
  let resolved;
  try {
    resolved = resolveContentFile(raw, base);
  } catch (err) {
    if (err?.statusCode === 400) throw err;
    resolved = "";
  }
  if (!resolved) {
    const err = new Error(`Media file is outside the current document folder: ${resolved}`);
    err.statusCode = 403;
    throw err;
  }
  return resolved;
}

export async function storeAsset(body) {
  const current = body.file ? safeOpenFile(body.file) : "";
  const originalName = sanitizeAssetName(body.name, imageAssetP("", body.type) ? "image.png" : "attachment");
  const isImage = imageAssetP(originalName, body.type);
  const baseDir = current ? dirname(current) : noteRoot;
  const allowedRoot = current && standaloneFile(current) ? contentRootForFile(current) : noteRoot;
  const targetDir = join(baseDir, isImage ? "images" : "attachments", assetFolderName(current));
  if (!inside(targetDir, noteRoot) && !inside(targetDir, allowedRoot)) {
    const err = new Error(`Asset directory is outside the current document folder: ${targetDir}`);
    err.statusCode = 403;
    throw err;
  }
  const rawData = String(body.data || "");
  if (!rawData) {
    const err = new Error("Missing asset data");
    err.statusCode = 400;
    throw err;
  }
  const target = await uniqueAssetPath(targetDir, originalName);
  await mkdir(targetDir, { recursive: true });
  await writeFile(target, Buffer.from(rawData, "base64"));
  return {
    ok: true,
    file: target,
    name: basename(target),
    type: fileContentType(target),
    isImage,
    markdownPath: markdownRelativePath(current, target),
  };
}

export async function storeAssetFromPath(body) {
  const current = body.file ? safeOpenFile(body.file) : "";
  const source = resolveUserPath(body.path || body.source || "");
  if (!source) {
    const err = new Error("Missing asset source path");
    err.statusCode = 400;
    throw err;
  }
  const info = await stat(source);
  if (!info.isFile()) {
    const err = new Error(`Asset source is not a regular file: ${source}`);
    err.statusCode = 400;
    throw err;
  }
  const originalName = sanitizeAssetName(body.name || basename(source), "attachment");
  const type = String(body.type || fileContentType(source));
  const isImage = imageAssetP(originalName, type);
  const baseDir = current ? dirname(current) : noteRoot;
  const allowedRoot = current && standaloneFile(current) ? contentRootForFile(current) : noteRoot;
  const targetDir = join(baseDir, isImage ? "images" : "attachments", assetFolderName(current));
  if (!inside(targetDir, noteRoot) && !inside(targetDir, allowedRoot)) {
    const err = new Error(`Asset directory is outside the current document folder: ${targetDir}`);
    err.statusCode = 403;
    throw err;
  }
  const target = await uniqueAssetPath(targetDir, originalName);
  await mkdir(targetDir, { recursive: true });
  await copyFile(source, target);
  return {
    ok: true,
    file: target,
    name: basename(target),
    type: fileContentType(target),
    isImage,
    markdownPath: markdownRelativePath(current, target),
  };
}

function tikzVersionMs(value) {
  const raw = String(value || "").trim();
  if (!raw) return 0;
  if (/^\d{13}$/.test(raw)) return Number(raw);
  if (/^\d{10}$/.test(raw)) return Number(raw) * 1000;
  const compact = raw.match(/^(\d{4})(\d{2})(\d{2})(?:[-_T]?(\d{2})(\d{2})(\d{2})?)?$/);
  if (compact) {
    const [, y, m, d, hh = "00", mm = "00", ss = "00"] = compact;
    return new Date(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss)).getTime();
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeTikzForLatex(source) {
  const cleaned = String(source || "")
    .split(/\r?\n/)
    .map((line) => {
      for (let i = 0; i < line.length; i++) {
        if (line[i] !== "%") continue;
        let slashCount = 0;
        for (let j = i - 1; j >= 0 && line[j] === "\\"; j--) slashCount++;
        if (slashCount % 2 === 0) return line.slice(0, i).trimEnd();
      }
      return line;
    })
    .join("\n")
    .trim();
  if (!cleaned) return "";
  if (/\\documentclass\b|\\begin\s*\{\s*document\s*\}/.test(cleaned)) return cleaned;
  if (/\\begin\s*\{\s*tikzpicture\s*\}/.test(cleaned)) {
    return [
      "\\documentclass[tikz,border=2pt]{standalone}",
      "\\begin{document}",
      cleaned,
      "\\end{document}",
    ].join("\n");
  }
  return [
    "\\documentclass[tikz,border=2pt]{standalone}",
    "\\begin{document}",
    "\\begin{tikzpicture}",
    cleaned,
    "\\end{tikzpicture}",
    "\\end{document}",
  ].join("\n");
}

function executablePath(command) {
  if (String(command || "").includes(sep) && existsSync(command)) return command;
  const paths = [
    ...(process.env.PATH || "").split(delimiter),
    // Emacs may start Noema with a stale PATH (for example before the
    // user's shell init has added ~/.local/bin).  Codex and other user-local
    // CLIs commonly live here, so resolve them explicitly as well.
    join(homedir(), ".local", "bin"),
    join(homedir(), ".nix-profile", "bin"),
    "/run/current-system/sw/bin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ].filter(Boolean);
  for (const dir of paths) {
    const candidate = join(dir, command);
    if (existsSync(candidate)) return candidate;
  }
  return command;
}

function commandOutputTail(err) {
  const parts = [
    err?.message,
    err?.stderr,
    err?.stdout,
  ].filter(Boolean).map((part) => String(part).trim()).filter(Boolean);
  const text = parts.join("\n");
  if (!text) return "";
  return text.split(/\r?\n/).slice(-8).join("\n");
}

export async function renderTikzAsset(body) {
  const current = body.file ? safeOpenFile(body.file) : "";
  if (!current) {
    const err = new Error("Missing current note file");
    err.statusCode = 400;
    throw err;
  }
  const id = sanitizeAssetName(body.id || createHash("sha1").update(String(body.source || "")).digest("hex").slice(0, 12), "tikz");
  const timestamp = String(body.timestamp || body.version || "").trim();
  const baseDir = dirname(current);
  const allowedRoot = current && standaloneFile(current) ? contentRootForFile(current) : noteRoot;
  const targetDir = join(baseDir, "images", assetFolderName(current));
  if (!inside(targetDir, noteRoot) && !inside(targetDir, allowedRoot)) {
    const err = new Error(`Asset directory is outside the current document folder: ${targetDir}`);
    err.statusCode = 403;
    throw err;
  }
  const target = join(targetDir, `tikz-${id}.svg`);
  const wantedMs = tikzVersionMs(timestamp);
  const existing = existsSync(target) ? await stat(target) : null;
  if (existing && (!wantedMs || existing.mtimeMs >= wantedMs)) {
    return {
      ok: true,
      file: target,
      name: basename(target),
      type: "image/svg+xml",
      isImage: true,
      markdownPath: markdownRelativePath(current, target),
      rendered: false,
      mtimeMs: existing.mtimeMs,
    };
  }

  const tex = normalizeTikzForLatex(body.source || "");
  if (!tex) {
    const err = new Error("Missing TikZ source");
    err.statusCode = 400;
    throw err;
  }

  const tmp = await runtimeMkdtemp("tikz", current);
  let latexError = null;
  let dvisvgmError = null;
  let mutoolError = null;
  try {
    const texFile = join(tmp, "main.tex");
    const pdfFile = join(tmp, "main.pdf");
    const svgFile = join(tmp, "out.svg");
    await writeFile(texFile, tex, "utf8");
    try {
      await execFileAsync(executablePath("pdflatex"), [
        "-interaction=nonstopmode",
        "-halt-on-error",
        `-output-directory=${tmp}`,
        texFile,
      ], { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 });
    } catch (err) {
      latexError = err;
      throw err;
    }

    try {
      await execFileAsync(executablePath("dvisvgm"), [
        "--pdf",
        "--no-fonts",
        "--exact",
        "--bbox=min",
        "-o",
        svgFile,
        pdfFile,
      ], { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 });
    } catch (err) {
      dvisvgmError = err;
      try {
        await execFileAsync(executablePath("mutool"), [
          "convert",
          "-o",
          svgFile,
          pdfFile,
        ], { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 });
      } catch (fallbackErr) {
        mutoolError = fallbackErr;
        throw fallbackErr;
      }
    }
    const renderedSvgFile = existsSync(svgFile)
      ? svgFile
      : existsSync(join(tmp, "out1.svg"))
        ? join(tmp, "out1.svg")
        : svgFile;
    if (!existsSync(renderedSvgFile)) {
      throw new Error("TikZ SVG conversion did not produce an SVG file");
    }
    await mkdir(targetDir, { recursive: true });
    await copyFile(renderedSvgFile, target);
    const info = await stat(target);
    return {
      ok: true,
      file: target,
      name: basename(target),
      type: "image/svg+xml",
      isImage: true,
      markdownPath: markdownRelativePath(current, target),
      rendered: true,
      mtimeMs: info.mtimeMs,
    };
  } catch (err) {
    const details = [
      latexError ? `pdflatex: ${commandOutputTail(latexError)}` : "",
      dvisvgmError ? `dvisvgm: ${commandOutputTail(dvisvgmError)}` : "",
      mutoolError ? `mutool: ${commandOutputTail(mutoolError)}` : "",
    ].filter(Boolean).join("\n\n");
    return {
      ok: false,
      file: target,
      name: basename(target),
      type: "image/svg+xml",
      isImage: true,
      markdownPath: markdownRelativePath(current, target),
      rendered: false,
      message: details || (err instanceof Error ? err.message : String(err)),
    };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

function pathSuggestionDirectoryPrefix(value) {
  const raw = String(value || "./").replace(/\\/g, "/");
  const slash = raw.lastIndexOf("/");
  return slash >= 0 ? raw.slice(0, slash + 1) : "./";
}

function pathSuggestionDirectory(current, prefix) {
  const displayPrefix = pathSuggestionDirectoryPrefix(prefix);
  const rootBased = displayPrefix.startsWith("/");
  const allowedRoot = contentRootForFile(current);
  const baseDir = rootBased ? allowedRoot : dirname(current);
  const relativeDir = rootBased ? displayPrefix.replace(/^\/+/, "") : displayPrefix;
  const dir = resolve(baseDir, relativeDir || ".");
  if (!inside(dir, allowedRoot)) return null;
  const relParts = relativeCanonical(allowedRoot, dir).split(sep).filter(Boolean);
  if (relParts.some((part) => excludedDirs.has(part))) return null;
  return { dir, displayPrefix };
}

export async function pathSuggestionsForFile(file, prefix = "./") {
  const current = file ? safeOpenFile(file) : "";
  if (!current) return [];
  const target = pathSuggestionDirectory(current, prefix);
  if (!target) return [];
  const version = notesIndexVersion;
  const cached = pathSuggestionDirListingCache.get(target.dir);
  let entries = cached && cached.version === version ? cached.entries : null;
  if (!entries) {
    try {
      entries = await readdir(target.dir, { withFileTypes: true });
    } catch {
      return [];
    }
    pathSuggestionDirListingCache.set(target.dir, { entries, version });
    if (pathSuggestionDirListingCache.size > PATH_SUGGESTION_DIR_CACHE_LIMIT) {
      const oldest = pathSuggestionDirListingCache.keys().next();
      if (!oldest.done) pathSuggestionDirListingCache.delete(oldest.value);
    }
  }
  return entries
    .filter((entry) => !entry.name.startsWith("."))
    .filter((entry) => entry.isFile() || (entry.isDirectory() && !excludedDirs.has(entry.name)))
    .map((entry) => `${target.displayPrefix}${entry.name}${entry.isDirectory() ? "/" : ""}`)
    .sort((a, b) => {
      const aDir = a.endsWith("/");
      const bDir = b.endsWith("/");
      return aDir === bDir ? a.localeCompare(b) : aDir ? -1 : 1;
    })
    .slice(0, 500);
}

function normalizeLeanTag(value) {
  return String(value || "")
    .trim()
    .replace(/^\[|\]$/g, "")
    .replace(/[^A-Za-z0-9_.:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function scanCodeRegions(text) {
  const source = String(text || "");
  const regions = [];
  const matches = [];
  // Matches any line-comment prefix (#, //, --, ;) followed by @aaronnote or @note-code + tag.
  // Leading whitespace is allowed so indented markers work too.
  const tagRe = /^[ \t]*(?:--|#|\/\/|;)[ \t]*@(?:aaronnote|note-code)[ \t]+([A-Za-z0-9_.:-]+)[ \t]*$/gm;
  let match;
  while ((match = tagRe.exec(source)) !== null) {
    const markerFrom = match.index;
    const markerTo = tagRe.lastIndex;
    const bodyFrom = source.slice(markerTo, markerTo + 1) === "\n" ? markerTo + 1 : markerTo;
    matches.push({ tag: match[1], markerFrom, markerTo, bodyFrom });
  }
  for (let i = 0; i < matches.length; i++) {
    const current = matches[i];
    const next = matches[i + 1];
    const bodyTo = next ? next.markerFrom : source.length;
    regions.push({ ...current, bodyTo, body: source.slice(current.bodyFrom, bodyTo) });
  }
  return regions;
}

function languageForFile(file) {
  const ext = extname(file).toLowerCase();
  const map = {
    ".lean": "lean4", ".py": "python", ".r": "r", ".jl": "julia",
    ".js": "javascript", ".ts": "typescript", ".jsx": "javascript", ".tsx": "typescript",
    ".el": "elisp", ".lisp": "lisp", ".scm": "scheme", ".clj": "clojure",
    ".sh": "bash", ".bash": "bash", ".zsh": "zsh",
    ".c": "c", ".h": "c", ".cpp": "cpp", ".cc": "cpp", ".hpp": "cpp",
    ".java": "java", ".rs": "rust", ".go": "go", ".hs": "haskell",
    ".rb": "ruby", ".kt": "kotlin", ".swift": "swift", ".cs": "csharp",
    ".ml": "ocaml", ".lua": "lua", ".sql": "sql",
  };
  return map[ext] || (ext.length > 1 ? ext.slice(1) : "text");
}

function rememberNoteCodeFile(file, info, text, regions) {
  const bytes = Buffer.byteLength(text, "utf8");
  const existing = noteCodeFileCache.get(file);
  if (existing) noteCodeFileCacheBytes -= existing.bytes;
  noteCodeFileCache.delete(file);
  noteCodeFileCache.set(file, { mtimeMs: info.mtimeMs, size: info.size, bytes, regions });
  noteCodeFileCacheBytes += bytes;
  while (noteCodeFileCache.size > NOTE_CODE_FILE_CACHE_LIMIT || noteCodeFileCacheBytes > NOTE_CODE_FILE_CACHE_BYTES) {
    const oldest = noteCodeFileCache.keys().next().value;
    if (!oldest) break;
    const removed = noteCodeFileCache.get(oldest);
    noteCodeFileCache.delete(oldest);
    noteCodeFileCacheBytes -= removed?.bytes || 0;
  }
}

async function loadNoteCodeRegionsForFile(file) {
  const info = await stat(file);
  if (!info.isFile()) {
    const err = new Error(`Not a regular file: ${file}`);
    err.statusCode = 400;
    throw err;
  }
  const cached = noteCodeFileCache.get(file);
  if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
    noteCodeFileCache.delete(file);
    noteCodeFileCache.set(file, cached);
    return { info, regions: cached.regions };
  }
  const text = await readFile(file, "utf8");
  const regions = scanCodeRegions(text);
  rememberNoteCodeFile(file, info, text, regions);
  return { info, regions };
}

function noteCodeRegionsForFile(file) {
  const existing = noteCodeFilePending.get(file);
  if (existing) return existing;
  const pending = loadNoteCodeRegionsForFile(file)
    .finally(() => {
      if (noteCodeFilePending.get(file) === pending) noteCodeFilePending.delete(file);
    });
  noteCodeFilePending.set(file, pending);
  return pending;
}

export async function readNoteCodeRegion(body) {
  const notePath = safeOpenFile(body?.notePath || body?.file || "");
  const rawPath = String(body?.path || "").trim();
  const id = normalizeLeanTag(body?.id || "");
  if (!rawPath || !id) {
    const err = new Error("Missing note-code path or id");
    err.statusCode = 400;
    throw err;
  }
  const baseDir = dirname(notePath);
  const allowedRoot = contentRootForFile(notePath);
  const file = resolveNoteCodePath(rawPath, baseDir, allowedRoot);
  if (!file) {
    const err = new Error(`Code file is outside the allowed root: ${rawPath}`);
    err.statusCode = 403;
    throw err;
  }
  const { info, regions } = await noteCodeRegionsForFile(file);
  const region = regions.find((item) => item.tag === id);
  if (!region) {
    const err = new Error(`Region not found: ${id}`);
    err.statusCode = 404;
    throw err;
  }
  return { ok: true, file, path: rawPath, id, body: region.body, language: languageForFile(file), mtimeMs: info.mtimeMs, size: info.size };
}

function assetCandidateFile(file) {
  const relParts = relativeCanonical(noteRoot, file).split(sep).map((part) => part.toLowerCase());
  if (relParts.includes(".lean")) return false;
  if (!relParts.includes("images") && !relParts.includes("attachments")) return false;
  const ext = extname(file).toLowerCase();
  return !leanSourceFile(file) && !noteExts.has(ext) && basename(file) !== ".aaronnote-keep";
}

function assetReferenceSourceFile(file) {
  const relParts = relativeCanonical(noteRoot, file).split(sep).map((part) => part.toLowerCase());
  if (relParts.includes(".lean")) return false;
  return /\.(?:md|markdown|typ)$/i.test(file);
}

function resolveReferencedAsset(href, noteFile) {
  const protocol = hrefProtocol(href);
  if (protocol && protocol !== "file") return "";
  const rawPath = hrefPath(href);
  if (!rawPath || rawPath.startsWith("#")) return "";
  try {
    const file = resolveContentFile(rawPath, noteFile);
    return inside(file, noteRoot) || inside(file, contentRootForFile(noteFile)) ? file : "";
  } catch {
    return "";
  }
}

export function assetRefsFromContent(content, noteFile) {
  const refs = new Set();
  const addHref = (href) => {
    const file = resolveReferencedAsset(href, noteFile);
    if (file) refs.add(file);
  };
  for (const href of markdownLinkHrefs(content)) {
    addHref(href);
  }
  for (const match of content.matchAll(/\b(?:src|href|poster|data-src)\s*=\s*["']([^"']+)["']/gi)) {
    addHref(match[1]);
  }
  for (const match of content.matchAll(/\bsrcset\s*=\s*["']([^"']+)["']/gi)) {
    for (const item of String(match[1] || "").split(",")) {
      const href = item.trim().split(/\s+/, 1)[0] || "";
      addHref(href);
    }
  }
  for (const match of content.matchAll(/\burl\(\s*(['"]?)([^'")]+)\1\s*\)/gi)) {
    addHref(match[2]);
  }
  for (const match of content.matchAll(/\[\[(?:file:)?([^\]\n]+?)(?:\][^\]\n]*)?\]\]/gi)) {
    addHref(match[1]);
  }
  for (const match of content.matchAll(/^\s*#\+include:\s+["<]?([^">\n]+)[">]?/gim)) {
    addHref(match[1]);
  }
  return [...refs];
}

function assetCleanupStateFile() {
  return join(stateRoot, "asset-cleanup", "state.json");
}

async function readAssetCleanupState() {
  try {
    const raw = await readFile(assetCleanupStateFile(), "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function writeAssetCleanupState(next) {
  await atomicWriteFile(assetCleanupStateFile(), `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

async function assetReferenceFiles() {
  return walkFiles(noteScanRoot, assetReferenceSourceFile);
}

async function assetSourceStats(files) {
  const stats = {};
  await mapLimit(files, scanConcurrency, async (file) => {
    try {
      const info = await stat(file);
      stats[file] = { mtimeMs: info.mtimeMs, size: info.size };
    } catch {}
  });
  return stats;
}

async function assetRefsForFiles(files) {
  const refsByFile = {};
  await mapLimit(files, scanConcurrency, async (file) => {
    try {
      const content = await readFile(file, "utf8");
      refsByFile[file] = assetRefsFromContent(content, file);
    } catch {
      refsByFile[file] = [];
    }
  });
  return refsByFile;
}

async function assetRefsByFileIncremental() {
  const state = await readAssetCleanupState();
  const schemaOk = state.schemaVersion === ASSET_CLEANUP_SCHEMA;
  const cachedRefs = state.refsByFile && typeof state.refsByFile === "object" ? state.refsByFile : {};
  const sourceFiles = await assetReferenceFiles();
  const sourceSet = new Set(sourceFiles);
  const sourceStats = await assetSourceStats(sourceFiles);
  const previousStats = state.sourceStats && typeof state.sourceStats === "object" ? state.sourceStats : {};
  const assetStale = state.lastFullAt
    ? (Date.now() - new Date(state.lastFullAt).getTime()) > ROAM_FULL_SYNC_INTERVAL_MS
    : false;
  const forceFull = !schemaOk || !state.lastScannedCommit || assetStale;
  let refsByFile = {};
  let full = forceFull;
  let changedFiles = null;
  if (!full) {
    changedFiles = await changedRoamFilesSince(noteRoot, state.lastScannedCommit);
    if (changedFiles === null) full = true;
  }
  if (full) {
    refsByFile = await assetRefsForFiles(sourceFiles);
  } else {
    refsByFile = { ...cachedRefs };
    for (const file of Object.keys(refsByFile)) {
      if (!sourceSet.has(file)) delete refsByFile[file];
    }
    const statChanged = sourceFiles.filter((file) => {
      const prev = previousStats[file];
      const next = sourceStats[file];
      return !prev || !next || Number(prev.mtimeMs) !== Number(next.mtimeMs) || Number(prev.size) !== Number(next.size);
    });
    const changedSources = [...new Set([
      ...(changedFiles || []).map((file) => resolveUserPath(file)).filter((file) => sourceSet.has(file)),
      ...statChanged,
    ])];
    Object.assign(refsByFile, await assetRefsForFiles(changedSources));
  }
  const sha = await headSha(noteRoot);
  await writeAssetCleanupState({
    schemaVersion: ASSET_CLEANUP_SCHEMA,
    lastScannedCommit: sha || state.lastScannedCommit || "",
    lastFullAt: full ? new Date().toISOString() : state.lastFullAt || "",
    lastScannedAt: new Date().toISOString(),
    sourceStats,
    refsByFile,
  }).catch(() => {});
  return refsByFile;
}

export async function scanUnusedAssets() {
  const refsByFile = await assetRefsByFileIncremental();
  const referenced = new Set();
  for (const refs of Object.values(refsByFile)) {
    if (!Array.isArray(refs)) continue;
    for (const ref of refs) referenced.add(resolve(String(ref)));
  }
  const files = await walkFiles(noteRoot, assetCandidateFile);
  const assets = await mapLimit(files, scanConcurrency, async (file) => {
    try {
      const info = await stat(file);
      if (!info.isFile() || referenced.has(file)) return null;
      const rel = relativeCanonical(noteRoot, file).split(sep).join("/");
      return {
        file,
        path: rel,
        name: basename(file),
        type: fileContentType(file),
        size: info.size,
        mtimeMs: info.mtimeMs,
        isImage: imageAssetP(file),
      };
    } catch {}
    return null;
  });
  return assets
    .filter(Boolean)
    .sort((a, b) => String(a.path).localeCompare(String(b.path)));
}

export async function trashUnusedAssets(body) {
  const requested = Array.isArray(body.files) ? body.files.map((file) => resolve(String(file || ""))) : [];
  if (requested.length === 0) return { type: "unused-assets-trash", ok: true, trashed: [], skipped: [], assets: await scanUnusedAssets() };
  const assets = await scanUnusedAssets();
  const byFile = new Map(assets.map((asset) => [asset.file, asset]));
  const trashed = [];
  const skipped = [];
  for (const file of requested) {
    const asset = byFile.get(file);
    if (!asset) {
      skipped.push(file);
      continue;
    }
    try {
      trashed.push({ ...asset, trashedTo: await moveToTrash(asset.file) });
    } catch {
      skipped.push(file);
    }
  }
  return { type: "unused-assets-trash", ok: true, trashed, skipped, assets: await scanUnusedAssets() };
}

function currentSessionManager() {
  return (sessionManager ??= new SessionManager({
    stateRoot,
    resolveFile: safeOpenFile,
    writeFile: atomicWriteFile,
  }));
}

export async function readRecentNotes() {
  return currentSessionManager().readRecentNotes();
}

export async function touchRecentNote(file, openedAt = Date.now()) {
  return currentSessionManager().touchRecentNote(file, openedAt);
}

export async function readCursorPositions() {
  return currentSessionManager().readCursorPositions();
}

export async function touchCursorPosition(body) {
  return currentSessionManager().touchCursorPosition(body);
}

function modeForFile(file) {
  const lower = file.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
  return "source";
}

function parseListValue(value, options = {}) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("(")) {
    return [...trimmed.matchAll(/"((?:[^"\\]|\\.)*)"/g)]
      .map((match) => match[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\"))
      .filter(Boolean);
  }
  const separator = options.splitSpaces === false ? /[,\n]+/ : /[, ]+/;
  return trimmed.split(separator).map((item) => item.trim()).filter(Boolean);
}

function parseMetaScalar(value) {
  let trimmed = String(value || "").trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    trimmed = trimmed.slice(1, -1);
  }
  if (trimmed === "true" || trimmed === "false") return trimmed === "true";
  return trimmed.replace(/\\_/g, "_");
}

function parseMetaLines(raw) {
  const meta = {};
  let currentList = "";
  for (const rawLine of raw.split(/\r?\n/)) {
    const item = rawLine.match(/^\s*-\s*(.+?)\s*$/);
    if (item && currentList) {
      if (!Array.isArray(meta[currentList])) meta[currentList] = [];
      meta[currentList].push(parseMetaScalar(item[1]));
      continue;
    }
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const pair = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!pair) continue;
    const key = pair[1].toLowerCase();
    const value = pair[2].trim();
    if (!value) {
      meta[key] = [];
      currentList = key;
      continue;
    }
    if (key === "tags" || key === "refs" || key === "aliases") {
      meta[key] = parseListValue(value, { splitSpaces: key !== "aliases" });
    } else {
      meta[key] = parseMetaScalar(value);
    }
    currentList = "";
  }
  return meta;
}

function parseFrontMatter(content) {
  const match = String(content || "").match(/^\s*---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  return match ? parseMetaLines(match[1]) : {};
}

function parseMetaBlock(content) {
  const match = content.match(/^\s*#\+begin\s+meta\s*\r?\n([\s\S]*?)\r?\n\s*#\+end\s+meta\s*$/im);
  return match ? parseMetaLines(match[1]) : {};
}

function metaBlockRange(content) {
  const match = content.match(/^\s*#\+begin\s+meta\s*\r?\n[\s\S]*?\r?\n\s*#\+end\s+meta\s*(?:\r?\n)*/im);
  if (!match || match.index == null) return null;
  return { from: match.index, to: match.index + match[0].length, text: match[0] };
}

function normalizeTags(tags) {
  const byKey = new Map();
  for (const tag of (Array.isArray(tags) ? tags : parseListValue(tags))) {
    const clean = String(tag).trim().replace(/^#/, "");
    if (!clean) continue;
    const key = clean.toLowerCase();
    const previous = byKey.get(key);
    if (!previous || clean === key) byKey.set(key, clean);
  }
  return [...byKey.values()].sort((a, b) => a.localeCompare(b));
}

function roamOffFromMeta(meta) {
  return String(meta.roam ?? "").trim().toLowerCase() === "off";
}

function hasRoamMeta(content) {
  const meta = noteMetadata(content);
  const id = String(meta.id ?? "").trim();
  return id.length > 0 && !roamOffFromMeta(meta);
}

function hasNoteMetadata(content) {
  return Object.keys(noteMetadata(content)).length > 0;
}

function ensureDate(value = "") {
  return String(value || new Date().toISOString().slice(0, 10));
}

function buildMetaBlock(fields, options = {}) {
  const tags = normalizeTags(fields.tags || []);
  const refs = normalizeTags(fields.refs || []);
  const aliases = normalizeTags(fields.aliases || []);
  const project = String(fields.project || fields.proj || "").trim();
  const lines = ["#+begin meta"];
  // Omit the roam id for standalone (non-roam) notes so they keep a meta block
  // (tags etc.) without being synced into the roam graph database.
  if (fields.id) lines.push(`id: ${fields.id}`);
  lines.push(
    `title: ${fields.title}`,
    `date: ${ensureDate(fields.date)}`,
    `kind: ${fields.kind || defaultNoteKind}`,
  );
  if (roamOffFromMeta(fields)) lines.push("roam: off");
  if (project) lines.push(`project: ${project}`);
  if (fields.extend) lines.push(`extend: ${String(fields.extend).replace(/\r?\n/g, " ")}`);
  if (fields.bib) lines.push(`bib: ${Array.isArray(fields.bib) ? fields.bib.join(", ") : String(fields.bib).replace(/\r?\n/g, " ")}`);
  if (fields.css) lines.push(`css: ${String(fields.css).replace(/\r?\n/g, " ")}`);
  lines.push(
    `tags: ${tags.join(", ")}`,
    `refs: ${refs.join(", ")}`,
  );
  if (aliases.length > 0) lines.push(`aliases: ${aliases.join(", ")}`);
  if (fields.source) lines.push(`source: ${fields.source}`);
  if (fields.summary) lines.push(`summary: ${String(fields.summary).replace(/\r?\n/g, " ")}`);
  if (fields.private !== undefined) lines.push(`private: ${fields.private === true || fields.private === "true" ? "true" : "false"}`);
  if (options.includeSummary) lines.push("#+begin summary", "", "#+end summary");
  lines.push("#+end meta", "");
  return lines.join("\n");
}

function metaFieldsForFile(file, content, patch = {}) {
  const current = noteMetadata(content);
  const title = String(patch.title || current.title || titleFromContent(file, content) || basename(file, extname(file)) || "Untitled").trim();
  const hasPatchId = Object.prototype.hasOwnProperty.call(patch, "id");
  const keepsNoRoamId = !current.id && roamOffFromMeta({ ...current, ...patch });
  const id = String(hasPatchId ? patch.id : (current.id || (keepsNoRoamId ? "" : `${timestampId()}-${slugifyTitle(title)}`))).trim();
  return {
    ...current,
    ...patch,
    id,
    title,
    date: ensureDate(patch.date || current.date),
    kind: normalizeNoteKind(patch.kind || current.kind || defaultNoteKind),
    tags: normalizeTags(patch.tags ?? current.tags ?? []),
    refs: normalizeTags(patch.refs ?? current.refs ?? []),
    aliases: normalizeTags(patch.aliases ?? current.aliases ?? []),
  };
}

function removeMetaBlock(content) {
  const range = metaBlockRange(content);
  if (!range) return content;
  return `${content.slice(0, range.from)}${content.slice(range.to)}`.replace(/^\s+/, "");
}

function upsertMetaBlock(file, content, patch = {}) {
  const nextMeta = buildMetaBlock(metaFieldsForFile(file, content, patch));
  const body = removeMetaBlock(content);
  return `${nextMeta}\n${body.replace(/^\s+/, "")}`;
}

// Insert a `roam: off` line into an existing meta block (used for regular notes
// created from a template that already supplies its own meta). Preserves the rest
// of the block and reports the byte offset inserted so callers can shift a cursor
// selection that sits after the meta block.
function withMetaRoamOff(content) {
  const range = metaBlockRange(content);
  if (!range || roamOffFromMeta(parseMetaBlock(content))) return { content, offset: 0 };
  const insertLine = "roam: off\n";
  const block = range.text;
  const kindMatch = block.match(/^[ \t]*kind:[^\n]*\r?\n/im);
  const beginMatch = block.match(/^\s*#\+begin\s+meta\s*\r?\n/i);
  const within = kindMatch?.index != null
    ? kindMatch.index + kindMatch[0].length
    : (beginMatch ? beginMatch[0].length : 0);
  const insertAt = range.from + within;
  return {
    content: `${content.slice(0, insertAt)}${insertLine}${content.slice(insertAt)}`,
    offset: insertLine.length,
  };
}

// New-note templates all expose the same nested Summary/Abstract editor. A
// template may provide its own meta block, so creation cannot rely solely on
// buildMetaBlock() to add it.
function withMetaSummary(content) {
  const range = metaBlockRange(content);
  if (!range || /(^|\n)[ \t]*#\+begin(?:_|\s+)summary(?:\s|$)/i.test(range.text)) {
    return { content, offset: 0 };
  }
  const close = /(^|\r?\n)([ \t]*#\+end(?:_|\s+)meta\s*)/im.exec(range.text);
  if (!close || close.index == null) return { content, offset: 0 };
  const insert = "#+begin summary\n\n#+end summary\n";
  const insertAt = range.from + close.index + (close[1]?.length || 0);
  return {
    content: `${content.slice(0, insertAt)}${insert}${content.slice(insertAt)}`,
    offset: insert.length,
  };
}

function yamlishValue(content, key) {
  return content.match(new RegExp(`^\\s*${key}:\\s*"([^"]+)"`, "m"))?.[1]
    || content.match(new RegExp(`^\\s*${key}:\\s*([^\\n]+)`, "m"))?.[1]?.trim();
}

function typstUnescape(value) {
  return String(value || "")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

function parseTypstMetadata(content) {
  const match = content.match(/#metadata\s*\(\(([\s\S]*?)\)\)\s*<note>/m);
  if (!match) return {};
  const body = match[1];
  const fields = {};
  const pairs = [...body.matchAll(/([A-Za-z0-9_-]+)\s*:\s*/g)];
  for (let i = 0; i < pairs.length; i++) {
    const key = pairs[i][1].toLowerCase();
    const start = pairs[i].index + pairs[i][0].length;
    const end = i + 1 < pairs.length ? pairs[i + 1].index : body.length;
    const raw = body.slice(start, end).trim().replace(/,\s*$/, "").trim();
    if (!raw) continue;
    if (raw.startsWith("(")) {
      fields[key] = [...raw.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((item) => typstUnescape(item[1]));
    } else if (raw === "true" || raw === "false") {
      fields[key] = raw === "true";
    } else {
      const string = raw.match(/"((?:[^"\\]|\\.)*)"/);
      fields[key] = string ? typstUnescape(string[1]) : raw;
    }
  }
  return fields;
}

function noteMetadata(content) {
  return {
    ...parseFrontMatter(content),
    ...parseTypstMetadata(content),
    ...parseMetaBlock(content),
  };
}

function slugHeadingAnchor(value) {
  const slug = String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "section";
}

const SEMANTIC_MARKDOWN_OFFSET = 5;
const SEMANTIC_SECTION_LEVELS = {
  "": 2,
  sec: 2,
  section: 2,
  sub: 3,
  subsub: 4,
  subsubsub: 5,
};

function semanticOutlineFromInlineCommand(command) {
  const name = String(command?.name || "").toLowerCase();
  const title = String(command?.context || "").trim() || "Untitled";
  if (name === "part") {
    return {
      level: 1,
      text: title,
      slug: String(command.args?.id || "").trim() || slugHeadingAnchor(title),
      source: "semantic",
      kind: "part",
    };
  }
  if (name !== "section") return null;
  const level = SEMANTIC_SECTION_LEVELS[String(command.switchValue || "").trim().toLowerCase()];
  if (!level) return null;
  return {
    level,
    text: title,
    slug: String(command.args?.id || "").trim() || slugHeadingAnchor(title),
    source: "semantic",
    kind: "section",
  };
}

function semanticHeadingsFromLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed.startsWith("@@part") && !trimmed.startsWith("@@section")) return [];
  const command = scanInlineCommands(trimmed)[0];
  if (!command || command.fullFrom !== 0 || command.fullTo !== trimmed.length) return [];
  const outline = semanticOutlineFromInlineCommand(command);
  return outline ? [outline] : [];
}

function contentHasSemanticHeadings(lines) {
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && semanticHeadingsFromLine(line).length > 0) return true;
  }
  return false;
}

function noteHeadingsFromContent(content, note, used) {
  const withoutMeta = removeMetaBlock(String(content || ""));
  const lines = withoutMeta.split(/\r?\n/);
  const hasSemantic = contentHasSemanticHeadings(lines);
  const headings = [];
  let hasH1 = false;
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    for (const semantic of semanticHeadingsFromLine(line)) {
      let slug = semantic.slug || slugHeadingAnchor(semantic.text);
      const base = slug;
      for (let i = 2; used.has(slug); i++) slug = `${base}-${i}`;
      used.add(slug);
      headings.push({ ...semantic, slug, path: note.path || "", id: note.id || "" });
    }
    const match = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (!match) continue;
    const markdownLevel = match[1].length;
    const level = hasSemantic ? SEMANTIC_MARKDOWN_OFFSET + markdownLevel : markdownLevel;
    if (level === 1) hasH1 = true;
    const text = match[2].trim() || "Untitled";
    let slug = slugHeadingAnchor(text);
    const base = slug;
    for (let i = 2; used.has(slug); i++) slug = `${base}-${i}`;
    used.add(slug);
    headings.push({ level, text, slug, path: note.path || "", id: note.id || "", source: "markdown" });
  }
  if (!hasSemantic && !hasH1 && note.title) {
    let slug = slugHeadingAnchor(note.title);
    const base = slug;
    for (let i = 2; used.has(slug); i++) slug = `${base}-${i}`;
    used.add(slug);
    headings.unshift({ level: 1, text: note.title, slug, path: note.path || "", id: note.id || "", source: "title" });
  }
  return headings;
}

function domTargetsFromContent(content, note) {
  const stack = [];
  const labelStack = [];
  return noteHeadingsFromContent(content, note, new Set()).map((heading) => {
    const label = String(heading.text || heading.slug || "").trim();
    const slug = String(heading.slug || slugHeadingAnchor(label)).trim();
    const level = Math.max(1, Number(heading.level || 1));
    while (stack.length > 0 && stack[stack.length - 1].level >= level) {
      stack.pop();
      labelStack.pop();
    }
    const parentPath = stack[stack.length - 1]?.path || [];
    const parentLabels = labelStack[labelStack.length - 1]?.path || [];
    const path = [...parentPath, slug].filter(Boolean);
    const labelPath = [...parentLabels, label].filter(Boolean);
    stack.push({ level, path });
    labelStack.push({ level, path: labelPath });
    return {
      label,
      slug,
      path,
      labelPath,
      level,
      notePath: note.path || "",
    };
  }).filter((target) => target.label && target.slug && target.path.length > 0);
}

function pdfExportName(file) {
  const raw = file ? file.split(sep).pop() || "Noema.pdf" : "Noema.pdf";
  const stem = raw.replace(/\.[^.]+$/, "") || "Noema";
  return `${stem}.pdf`.replace(/[/:]/g, "-");
}

function slugifyTitle(title) {
  const slug = String(title || "untitled")
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase();
  return slug || "untitled";
}

function timestampId() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "T",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("");
}

function markdownForPdf(content) {
  return String(content ?? "")
    .replace(/^\s*#\+begin\s+meta\s*\n[\s\S]*?\n\s*\\?#\+end\s+meta\s*\n*/i, "")
    .replace(/^#\+begin\s+([A-Za-z][\w-]*)(?:\s+([^\n]+))?\s*$/gmi, (_m, kind, title = "") => {
      const label = String(kind).toLowerCase() === "summary" ? "Summary" : String(kind);
      return `::: {.${String(kind).toLowerCase()}}\n**${label}${title ? `: ${title}` : ""}.**`;
    })
    .replace(/^\\?#\+end\s+[A-Za-z][\w-]*\s*$/gmi, ":::");
}

export async function exportPdf(file, content) {
  const dir = await runtimeMkdtemp("pdf", file || "Noema.pdf");
  const input = join(dir, "input.md");
  const out = join(dir, "output.pdf");
  await writeFile(input, markdownForPdf(content), "utf8");
  try {
    await execFileAsync("pandoc", [
      input,
      "--from=markdown+tex_math_single_backslash+fenced_divs",
      "--pdf-engine=xelatex",
      "-V", "mainfont=Times New Roman",
      "-V", "CJKmainfont=FZLiuGongQuanKaiShuJF",
      "-V", "mathfont=GFS Neohellenic Math",
      "-V", "geometry:margin=1in",
      "-o", out,
    ], {
      cwd: noteRoot,
      maxBuffer: 1024 * 1024 * 8,
    });
    return {
      name: pdfExportName(file),
      data: await readFile(out),
    };
  } catch (err) {
    const message = [err.message, err.stderr, err.stdout].filter(Boolean).join("\n");
    const next = new Error(message || "PDF export failed");
    next.statusCode = 500;
    throw next;
  }
  finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function titleFromContent(file, content) {
  const meta = noteMetadata(content);
  if (meta.title) return String(meta.title);
  const typTitle = yamlishValue(content, "title");
  if (typTitle) return typTitle;
  const typHeading = content.match(/^=+\s+(.+)$/m)?.[1]?.trim();
  if (typHeading) return typHeading;
  const mdHeading = content.match(/^#+\s+(.+)$/m)?.[1]?.trim();
  if (mdHeading) return mdHeading;
  return file.split(sep).pop()?.replace(/\.[^.]+$/, "") || "Untitled";
}

function idFromContent(file, root, content) {
  const meta = noteMetadata(content);
  return meta.id || yamlishValue(content, "id") || relativeCanonical(root, file);
}

export function tagsFromContent(content) {
  const meta = noteMetadata(content);
  const tags = Array.isArray(meta.tags) ? [...meta.tags] : [];
  const lines = content.split(/\r?\n/);
  if (!Array.isArray(meta.tags)) {
    const start = lines.findIndex((line) => /^\s*tags:\s*$/.test(line));
    if (start >= 0) {
      for (const line of lines.slice(start + 1)) {
        const item = line.match(/^\s*-\s*(.+)$/);
        if (!item) break;
        tags.push(item[1].trim());
      }
    }
  }
  return normalizeTags(tags);
}

export function inlineTagsFromContent(content) {
  const tags = [];
  let inFence = false;
  for (const line of maskMetaSummaryContent(content).split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const stripped = line.replace(/`[^`\n]*`/g, "");
    for (const command of scanInlineCommands(stripped, "tag")) {
      const tag = String(command.context || "").trim();
      if (tag) tags.push(tag);
    }
  }
  return tags;
}

function decodeRef(ref) {
  let decoded = String(ref || "");
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    decoded = String(ref || "");
  }
  return decoded.replace(/\\([\\`*_[\](){}#+.!<>-])/g, "$1");
}

function refFromRoamHref(href) {
  const match = String(href || "").trim().match(/^roam:\/\/(.+)$/i);
  if (!match) return "";
  return refFromRoamLikeHref(String(href || "").trim());
}

function hrefProtocol(href) {
  return String(href || "").trim().match(/^([A-Za-z][\w+.-]*):/)?.[1]?.toLowerCase() || "";
}

function hrefPath(href) {
  const raw = String(href || "").trim();
  if (/^file:\/\//i.test(raw)) {
    try {
      return decodeRef(new URL(raw).pathname);
    } catch {
      return decodeRef(raw.replace(/^file:\/\//i, ""));
    }
  }
  if (/^file:/i.test(raw)) return decodeRef(raw.replace(/^file:/i, "").split(/[?#]/, 1)[0] || "");
  return decodeRef(raw.split(/[?#]/, 1)[0] || "");
}

function stripDomTargetFromPath(path) {
  const clean = String(path || "");
  const match = clean.match(/^(.+?\.(?:md|markdown|typ))@/i);
  if (match) return match[1];
  return clean;
}

function noteFileRefFromHref(href) {
  const protocol = hrefProtocol(href);
  if (protocol && protocol !== "file") return "";
  const path = stripDomTargetFromPath(hrefPath(href));
  return /\.(?:md|markdown|typ)$/i.test(path) ? path : "";
}

function refFromRoamLikeHref(href) {
  const raw = String(href || "").trim();
  const protocol = hrefProtocol(raw);
  if (protocol && protocol !== "roam") return "";
  if (protocol !== "roam" && !raw.includes("#") && !raw.includes("@")) return "";
  let body = raw.replace(/^roam:\/\//i, "");
  body = body.split(/[?&]/, 1)[0] || body;
  const hashIndex = body.indexOf("#");
  if (hashIndex >= 0) body = body.slice(0, hashIndex);
  const fileDomMatch = body.match(/^(.+?\.(?:md|markdown|typ))@/i);
  if (fileDomMatch) body = fileDomMatch[1];
  else {
    const atIndex = body.indexOf("@");
    if (atIndex >= 0) body = body.slice(0, atIndex);
  }
  const ref = decodeRef(body.replace(/^\/+/, "").replace(/[.,;:]+$/, "")).trim();
  if (!ref || ref === "." || ref === "./") return "";
  return ref;
}

function markdownEscapedAt(text, pos) {
  let slashes = 0;
  for (let i = pos - 1; i >= 0 && text[i] === "\\"; i--) slashes++;
  return slashes % 2 === 1;
}

function markdownLabelClose(text, open) {
  let depth = 0;
  for (let i = open + 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\" && i + 1 < text.length) {
      i++;
      continue;
    }
    if (ch === "[") {
      depth++;
      continue;
    }
    if (ch !== "]") continue;
    if (depth === 0) return i;
    depth--;
  }
  return -1;
}

function skipMarkdownSpaces(text, pos) {
  while (pos < text.length && /[ \t]/.test(text[pos])) pos++;
  return pos;
}

function parseMarkdownTitle(text, pos) {
  if (text[pos] !== '"') return null;
  let title = "";
  for (let i = pos + 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\" && i + 1 < text.length) {
      title += ch + text[i + 1];
      i++;
      continue;
    }
    if (ch === '"') return { title, end: i + 1 };
    if (ch === "\n" || ch === "\r") return null;
    title += ch;
  }
  return null;
}

function parseMarkdownDestination(text, pos) {
  let cursor = skipMarkdownSpaces(text, pos);
  let href = "";
  let hrefFrom = cursor;
  let hrefTo = cursor;
  if (text[cursor] === ")") return { href, end: cursor + 1 };
  if (text[cursor] === "<") {
    let end = -1;
    for (let i = cursor + 1; i < text.length; i++) {
      const ch = text[i];
      if (ch === "\n" || ch === "\r") return null;
      if (ch === ">" && !markdownEscapedAt(text, i)) {
        end = i;
        break;
      }
    }
    if (end < 0) return null;
    hrefFrom = cursor + 1;
    hrefTo = end;
    href = text.slice(cursor + 1, end);
    cursor = end + 1;
  } else {
    const start = cursor;
    let depth = 0;
    for (; cursor < text.length; cursor++) {
      const ch = text[cursor];
      if (ch === "\n" || ch === "\r") return null;
      if (ch === "\\" && cursor + 1 < text.length) {
        cursor++;
        continue;
      }
      if (ch === "(") {
        depth++;
        continue;
      }
      if (ch === ")") {
        if (depth === 0) break;
        depth--;
        continue;
      }
      if (depth === 0 && /[ \t]/.test(ch)) break;
    }
    hrefFrom = start;
    hrefTo = cursor;
    href = text.slice(start, cursor);
  }
  cursor = skipMarkdownSpaces(text, cursor);
  if (text[cursor] !== ")") {
    const title = parseMarkdownTitle(text, cursor);
    if (!title) return null;
    cursor = skipMarkdownSpaces(text, title.end);
  }
  if (text[cursor] !== ")") return null;
  return { href, hrefFrom, hrefTo, end: cursor + 1 };
}

function markdownLinkHrefs(text) {
  const hrefs = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "[" || markdownEscapedAt(text, i)) continue;
    const labelClose = markdownLabelClose(text, i);
    if (labelClose < 0 || text[labelClose + 1] !== "(") continue;
    const dest = parseMarkdownDestination(text, labelClose + 2);
    if (!dest) continue;
    hrefs.push(dest.href);
    i = dest.end - 1;
  }
  return hrefs;
}

function markdownLinkDestinations(text) {
  const destinations = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "[" || markdownEscapedAt(text, i)) continue;
    const labelClose = markdownLabelClose(text, i);
    if (labelClose < 0 || text[labelClose + 1] !== "(") continue;
    const dest = parseMarkdownDestination(text, labelClose + 2);
    if (!dest) continue;
    destinations.push(dest);
    i = dest.end - 1;
  }
  return destinations;
}

export function refsFromContent(content) {
  const meta = noteMetadata(content);
  const source = maskMetaSummaryContent(content);
  const refs = new Set(Array.isArray(meta.refs) ? meta.refs : []);
  refTokenPattern.lastIndex = 0;
  let match;
  while ((match = refTokenPattern.exec(source)) !== null) {
    if (match[1]) refs.add(match[1]);
    else refs.add(refFromRoamHref(match[0]));
  }
  for (const href of markdownLinkHrefs(source)) {
    const noteRef = noteFileRefFromHref(href);
    if (noteRef) refs.add(noteRef);
    const roamRef = refFromRoamLikeHref(href);
    if (roamRef) refs.add(roamRef);
  }
  return [...refs].filter(Boolean);
}

export function roamDbRefsFromContent(content) {
  const meta = noteMetadata(content);
  const source = maskMetaSummaryContent(content);
  const refs = new Set(Array.isArray(meta.refs) ? meta.refs : []);
  refTokenPattern.lastIndex = 0;
  let match;
  while ((match = refTokenPattern.exec(source)) !== null) {
    if (match[1]) refs.add(match[1]);
    else refs.add(refFromRoamHref(match[0]));
  }
  for (const href of markdownLinkHrefs(source)) {
    if (noteFileRefFromHref(href)) continue;
    const roamRef = refFromRoamLikeHref(href);
    if (roamRef) refs.add(roamRef);
  }
  return [...refs].filter(Boolean);
}

function aliasesFromContent(content) {
  const meta = noteMetadata(content);
  return Array.isArray(meta.aliases) ? meta.aliases : [];
}

function graphNoteKey(note) {
  return String(note.key || note.id || note.path || note.file || "").trim();
}

export function graphPayload(notes) {
  const graphNotes = notes.filter((note) => note.roam);
  const byId = new Map();
  for (const note of graphNotes) {
    const key = graphNoteKey(note);
    if (!key) continue;
    for (const ref of [key, note.id, note.path, note.link, note.source, note.file].filter(Boolean)) {
      byId.set(String(ref), key);
    }
  }
  const edges = [];
  for (const note of graphNotes) {
    const source = graphNoteKey(note);
    if (!source) continue;
    for (const ref of note.refs || []) {
      const target = byId.get(String(ref));
      if (target && target !== source) edges.push({ source, target });
    }
  }
  const tags = [...new Set(graphNotes.flatMap((note) => note.tags || []))].sort();
  return {
    type: "graph",
    meta: {
      generatedAt: new Date().toISOString(),
      noteCount: graphNotes.length,
      edgeCount: edges.length,
      tagCount: tags.length,
    },
    nodes: graphNotes.map((note) => ({
      key: graphNoteKey(note),
      id: note.id || "",
      title: note.title || "",
      path: note.path || "",
      link: note.link || note.path || "#",
      groupKey: note.groupKey || "",
      groupLabel: note.groupLabel || "",
      tags: note.tags || [],
      aliases: note.aliases || [],
    })),
    edges,
  };
}

export function wantedPages(notes) {
  const graphNotes = notes.filter((note) => note.roam);
  const byId = new Map();
  for (const note of graphNotes) {
    const key = graphNoteKey(note);
    if (!key) continue;
    for (const ref of [key, note.id, note.path, note.link, note.source, note.file].filter(Boolean)) {
      byId.set(String(ref), key);
    }
  }
  const wantedMap = new Map();
  for (const note of graphNotes) {
    const source = graphNoteKey(note);
    if (!source) continue;
    for (const ref of note.refs || []) {
      const strRef = String(ref);
      if (!byId.has(strRef)) {
        const entry = wantedMap.get(strRef) ?? { target: ref, by: new Set() };
        entry.by.add(source);
        wantedMap.set(strRef, entry);
      }
    }
  }
  return {
    type: "wanted-pages",
    items: [...wantedMap.values()].map((entry) => ({
      target: entry.target,
      by: [...entry.by],
    })),
  };
}

export function tagIndexPayload(notes) {
  const tags = new Map();
  const add = (tag, note, kind) => {
    const name = String(tag || "").trim();
    const key = graphNoteKey(note);
    if (!name || !key) return;
    const lower = name.toLowerCase();
    const entry = tags.get(lower) ?? { name, count: 0, notes: [], metaCount: 0, inlineCount: 0 };
    if (!entry.notes.some((item) => item.key === key)) {
      entry.notes.push({ key, id: note.id || "", title: note.title || "", path: note.path || "" });
      entry.count++;
    }
    if (kind === "inline") entry.inlineCount++;
    else entry.metaCount++;
    tags.set(lower, entry);
  };
  for (const note of notes.filter((item) => item.roam)) {
    for (const tag of note.tags || []) add(tag, note, "meta");
    for (const tag of note.inlineTags || []) add(tag, note, "inline");
  }
  const items = [...tags.values()]
    .map((entry) => ({
      ...entry,
      notes: entry.notes.sort((a, b) => a.title.localeCompare(b.title) || a.key.localeCompare(b.key)),
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return {
    type: "tags",
    tags: items,
    meta: {
      tagCount: items.length,
      noteCount: new Set(items.flatMap((entry) => entry.notes.map((note) => note.key))).size,
    },
  };
}

function dateFromContent(content) {
  const meta = noteMetadata(content);
  return String(meta.date || yamlishValue(content, "date") || "");
}

function sourceFromContent(content) {
  const meta = noteMetadata(content);
  return String(meta.source || "");
}

function projectFromContent(content) {
  const meta = noteMetadata(content);
  return String(meta.project || meta.proj || "").trim();
}

function normalizeNoteKind(value) {
  const item = Array.isArray(value) ? value[0] : value;
  const kind = String(item || "").trim().replace(/\\_/g, "_").toLowerCase();
  if (defaultNoteKindAliases.has(kind)) return defaultNoteKind;
  return noteKindPattern.test(kind) ? kind : defaultNoteKind;
}

export function kindFromContent(content) {
  const meta = noteMetadata(content);
  return normalizeNoteKind(meta.kind ?? meta.kinds ?? defaultNoteKind);
}

export function activeKindFromContent(content) {
  const kind = kindFromContent(content);
  return kind === defaultNoteKind ? "" : kind;
}

function summaryFromContent(content) {
  const meta = noteMetadata(content);
  if (meta.summary) return String(meta.summary);
  const withoutMeta = content
    .replace(/^\s*#\+begin\s+meta\s*\r?\n[\s\S]*?\r?\n\s*#\+end\s+meta\s*\r?\n*/im, "")
    .replace(/#metadata\s*\(\([\s\S]*?\)\)\s*<note>/m, "")
    .replace(/^#(?:import|show|set)[^\n]*$/gm, "")
    .replace(/#note\("([^"]+)"\)\[([^\]]+)\]/g, "$2")
    .replace(/^=+\s+/gm, "")
    .replace(/^#+\s+/gm, "")
    .replace(/[#*_`$()[\]{}]/g, " ");
  return withoutMeta.split(/\s+/).filter(Boolean).join(" ").slice(0, 220);
}

function groupKeyFor(file, root = noteScanRoot) {
  const parent = dirname(displayPathForScanRoot(file, root));
  return parent === "." ? "Root" : parent;
}

function groupLabelFor(groupKey) {
  if (!groupKey || groupKey === "Root") return "Root";
  const leaf = groupKey.split(sep).filter(Boolean).at(-1) || groupKey;
  return leaf.toUpperCase() === leaf ? leaf : leaf.replace(/[-_]/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function directoryPathParts(path) {
  return String(path || "")
    .replace(/^\.\/?/, "")
    .split(/[\\/]/)
    .filter(Boolean);
}

function directoryParentPath(path) {
  const parts = directoryPathParts(path);
  if (parts.length <= 1) return "Root";
  return parts.slice(0, -1).join("/");
}

function directoryAncestors(path) {
  if (!path || path === "Root") return ["Root"];
  const parts = directoryPathParts(path);
  const out = ["Root"];
  for (let i = 1; i <= parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}

function generatedPathPart(path) {
  return directoryPathParts(path).some((part) => generatedAttachmentDirs.has(part.toLowerCase()));
}

function ensureDirectory(map, path, generated = false) {
  const key = path && path !== "." ? path : "Root";
  const existing = map.get(key);
  if (existing) {
    existing.generated = existing.generated || generated;
    return existing;
  }
  const entry = {
    path: key,
    label: groupLabelFor(key),
    parent: directoryParentPath(key),
    noteCount: 0,
    fileCount: 0,
    generated,
  };
  map.set(key, entry);
  return entry;
}

async function scanFilesystemEntries(notes = []) {
  const directories = new Map();
  const files = [];
  ensureDirectory(directories, "Root");

  async function walk(dir, generatedParent = false) {
    const rel = displayPathForScanRoot(dir, noteScanRoot);
    const dirPath = rel ? rel : "Root";
    const generated = generatedParent || generatedPathPart(dirPath);
    ensureDirectory(directories, dirPath, generated);

    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".emacs.d") continue;
      if (entry.isDirectory() && excludedDirs.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (!inside(full, noteScanRoot)) continue;
      const childGenerated = generated || generatedAttachmentDirs.has(entry.name.toLowerCase());
      if (entry.isDirectory()) {
        await walk(full, childGenerated);
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        if (ext === ".lean" || noteExts.has(ext) || entry.name === ".aaronnote-keep") continue;
        try {
          const info = await stat(full);
          const path = displayPathForScanRoot(full, noteScanRoot);
          const dirPath = groupKeyFor(full, noteScanRoot);
          files.push({
            file: full,
            path,
            name: basename(full),
            ext: ext.replace(/^\./, ""),
            type: fileContentType(full),
            size: info.size,
            mtimeMs: info.mtimeMs,
            groupKey: dirPath,
            groupLabel: groupLabelFor(dirPath),
            generated: childGenerated || generatedPathPart(path),
          });
          for (const ancestor of directoryAncestors(dirPath)) {
            ensureDirectory(directories, ancestor, generatedPathPart(ancestor)).fileCount += 1;
          }
        } catch {}
      }
    }
  }

  await walk(noteScanRoot);

  for (const note of notes) {
    const group = note.groupKey || groupKeyFor(note.file || "", noteScanRoot);
    for (const ancestor of directoryAncestors(group)) {
      ensureDirectory(directories, ancestor, generatedPathPart(ancestor)).noteCount += 1;
    }
  }

  return {
    directories: [...directories.values()].sort((a, b) => {
      if (a.path === "Root") return -1;
      if (b.path === "Root") return 1;
      return a.path.localeCompare(b.path);
    }),
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
  };
}

export async function notesIndexPayload(notes = null) {
  const scanned = notes ?? await scanNotes();
  const fs = await scanFilesystemEntries(scanned);
  return { notes: scanned, directories: fs.directories, files: fs.files, indexVersion: notesIndexVersionValue() };
}

async function withNoteScanRoot(root, callback) {
  const prev = noteScanRoot;
  if (prev !== root) {
    noteScanRoot = root;
    notesSnapshotDirty = true;
  }
  try {
    return await callback();
  } finally {
    if (prev !== root) {
      noteScanRoot = prev;
      notesSnapshotDirty = true;
    }
  }
}

// Global roam callers must not inherit a standalone file's temporary scan root.
export async function roamNotesIndexPayload() {
  return await withNoteScanRoot(noteRoot, async () => notesIndexPayload());
}

function preferNote(candidate, current) {
  if (!current) return candidate;
  if (candidate.ext === "md" && current.ext !== "md") return candidate;
  if (candidate.path && candidate.path === current.source) return candidate;
  return current;
}

function normalizeNoteRefPath(value) {
  const raw = String(value || "").replace(/\\/g, "/");
  const absolute = raw.startsWith("/");
  const parts = [];
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
      else if (!absolute) parts.push(part);
      continue;
    }
    parts.push(part);
  }
  return `${absolute ? "/" : ""}${parts.join("/")}`;
}

function canonicalServerNoteRef(value) {
  const roamRef = refFromRoamLikeHref(String(value || ""));
  const ref = roamRef || String(value || "");
  return normalizeNoteRefPath(decodeRef(ref).trim().replace(/^\.\/+/, "")).toLowerCase();
}

function serverNoteRefValues(note) {
  const file = String(note?.file || "");
  const base = file.split(/[\\/]/).filter(Boolean).at(-1) || "";
  return [
    note?.id,
    note?.key,
    note?.title,
    note?.path,
    note?.link,
    note?.source,
    note?.file,
    base,
    ...(note?.aliases || []),
  ].filter((value) => String(value || "").trim());
}

function serverNoteReferenceIndex(notes) {
  const index = new Map();
  for (const note of notes) {
    for (const value of serverNoteRefValues(note)) {
      const key = canonicalServerNoteRef(value);
      if (key && !index.has(key)) index.set(key, note);
    }
  }
  return index;
}

function cloneNote(note) {
  return {
    ...note,
    aliases: [...(note.aliases || [])],
    tags: [...(note.tags || [])],
    inlineTags: [...(note.inlineTags || [])],
    refs: [...(note.refs || [])],
    backlinks: [...(note.backlinks || [])],
    leanBlocks: [...(note.leanBlocks || [])],
  };
}

function cloneNotes(notes) {
  return notes.map(cloneNote);
}

function cloneJson(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function emptyPlanningGroup() {
  return { todos: [], projects: [], milestones: [], clocks: [], nodes: [] };
}

function agendaCacheEnabled() {
  return process.env.AARONNOTE_AGENDA_CACHE !== "0" && noteScanRoot === noteRoot;
}

function agendaCacheFile() {
  return join(stateRoot, "cache", "agenda-cache.json");
}

function emptyAgendaPersistentCache() {
  return {
    schema: AGENDA_CACHE_SCHEMA,
    root: noteRoot,
    files: new Map(),
    payloads: new Map(),
  };
}

async function ensureAgendaPersistentCache() {
  if (!agendaCacheEnabled()) return null;
  const key = `${stateRoot}\0${noteRoot}`;
  if (agendaPersistentCache && agendaPersistentCacheKey === key) return agendaPersistentCache;
  if (agendaPersistentCacheLoad && agendaPersistentCacheKey === key) return await agendaPersistentCacheLoad;

  agendaPersistentCacheKey = key;
  agendaPersistentCacheLoad = (async () => {
    let next = emptyAgendaPersistentCache();
    try {
      const raw = JSON.parse(await readFile(agendaCacheFile(), "utf8"));
      if (raw?.schema === AGENDA_CACHE_SCHEMA && raw?.root === noteRoot) {
        next = {
          schema: AGENDA_CACHE_SCHEMA,
          root: noteRoot,
          files: new Map(Object.entries(raw.files || {})),
          payloads: new Map(Object.entries(raw.payloads || {})),
        };
      }
    } catch {}
    agendaPersistentCache = next;
    agendaPersistentCacheDirty = false;
    agendaPersistentCacheLoad = null;
    return agendaPersistentCache;
  })();
  return await agendaPersistentCacheLoad;
}

function trimAgendaPayloadCache(cache = agendaPersistentCache) {
  if (!cache || cache.payloads.size <= AGENDA_PAYLOAD_CACHE_LIMIT) return;
  const entries = [...cache.payloads.entries()]
    .sort((a, b) => Number(a[1]?.storedAt || 0) - Number(b[1]?.storedAt || 0));
  while (entries.length > AGENDA_PAYLOAD_CACHE_LIMIT) {
    const [key] = entries.shift();
    cache.payloads.delete(key);
  }
}

async function flushAgendaPersistentCache() {
  const cache = agendaPersistentCache;
  if (!cache || !agendaPersistentCacheDirty || !agendaCacheEnabled()) return;
  trimAgendaPayloadCache(cache);
  agendaPersistentCacheDirty = false;
  const payload = {
    schema: AGENDA_CACHE_SCHEMA,
    root: noteRoot,
    updatedAt: new Date().toISOString(),
    files: Object.fromEntries(cache.files),
    payloads: Object.fromEntries(cache.payloads),
  };
  try {
    await atomicWriteFile(agendaCacheFile(), `${JSON.stringify(payload)}\n`, "utf8");
  } catch {
    // The agenda cache is only an optimization; cache write failures must not
    // affect editor correctness.
  }
}

async function flushAgendaPersistentCacheQuietly() {
  try {
    await flushAgendaPersistentCache();
  } catch {}
}

function noteCacheRecordForPersist(cached) {
  const planning = cached.planning ? clonePlanningGroup(cached.planning) : null;
  return {
    mtimeMs: cached.mtimeMs || 0,
    size: cached.size || 0,
    note: cloneNote(cached.note),
    hasPlanning: Boolean(planning || cached.planningContent || cached.planningNeedsRead),
    planning,
  };
}

function rememberAgendaFileCache(file, cached) {
  if (!agendaPersistentCache || !agendaCacheEnabled() || !file || !cached?.note) return;
  agendaPersistentCache.files.set(file, noteCacheRecordForPersist(cached));
  agendaPersistentCacheDirty = true;
}

function forgetAgendaFileCache(file = "") {
  const cache = agendaPersistentCache;
  if (!cache) return;
  if (file) cache.files.delete(file);
  else cache.files.clear();
  cache.payloads.clear();
  agendaPersistentCacheDirty = true;
}

function noteCacheEntryFromPersistent(file, info, record) {
  if (!record || record.mtimeMs !== info.mtimeMs || record.size !== info.size || !record.note) return null;
  const planning = record.planning ? clonePlanningGroup(record.planning) : null;
  const note = cloneNote({ ...record.note, file });
  return {
    mtimeMs: record.mtimeMs,
    size: record.size,
    note,
    todos: planning ? planning.todos.map((todo) => ({ ...todo })) : (record.hasPlanning ? null : []),
    planning: planning || (record.hasPlanning ? null : emptyPlanningGroup()),
    planningContent: "",
    planningNeedsRead: Boolean(record.hasPlanning && !planning),
  };
}

async function cachedNoteEntryForFile(file, info) {
  const cache = await ensureAgendaPersistentCache();
  if (!cache) return null;
  return noteCacheEntryFromPersistent(file, info, cache.files.get(file));
}

function computeNotesSnapshotFingerprint(rawNotes) {
  const hash = createHash("sha1");
  hash.update(`${AGENDA_CACHE_SCHEMA}\0${noteScanRoot}\0`);
  const parts = [];
  for (const note of rawNotes || []) {
    const cached = note?.file ? noteCache.get(note.file) : null;
    parts.push(`${note?.file || ""}\0${note?.id || ""}\0${cached?.mtimeMs || 0}\0${cached?.size || 0}`);
  }
  for (const part of parts.sort()) hash.update(`${part}\n`);
  return hash.digest("hex");
}

function normalizedAgendaBody(body = {}) {
  const includeGantt = body.includeGantt === true;
  return {
    from: body.from ? String(body.from) : "",
    days: Math.max(1, Math.min(90, Number(body.days) || 7)),
    includePlanning: body.includePlanning === true || includeGantt,
    includeGantt,
  };
}

function agendaPayloadCacheKey(body, todayKey) {
  return createHash("sha1").update(stableJson({
    schema: AGENDA_CACHE_SCHEMA,
    root: noteRoot,
    scanRoot: noteScanRoot,
    snapshot: notesSnapshotFingerprint,
    today: todayKey,
    body: normalizedAgendaBody(body),
  })).digest("hex");
}

async function cachedAgendaPayload(body, todayKey) {
  if (!notesSnapshotFingerprint) return null;
  const cache = await ensureAgendaPersistentCache();
  if (!cache) return null;
  const key = agendaPayloadCacheKey(body, todayKey);
  const entry = cache.payloads.get(key);
  if (!entry || entry.snapshot !== notesSnapshotFingerprint || entry.today !== todayKey || entry.volatile) return null;
  return cloneJson(entry.payload);
}

function agendaPayloadIsVolatile(payload) {
  return Boolean(payload?.clocktable?.running);
}

async function rememberAgendaPayload(body, todayKey, payload) {
  if (!notesSnapshotFingerprint) return;
  if (agendaPayloadIsVolatile(payload)) {
    await flushAgendaPersistentCacheQuietly();
    return;
  }
  const cache = await ensureAgendaPersistentCache();
  if (!cache) return;
  const key = agendaPayloadCacheKey(body, todayKey);
  cache.payloads.set(key, {
    snapshot: notesSnapshotFingerprint,
    today: todayKey,
    body: normalizedAgendaBody(body),
    storedAt: Date.now(),
    payload: cloneJson(payload),
  });
  trimAgendaPayloadCache(cache);
  agendaPersistentCacheDirty = true;
  await flushAgendaPersistentCacheQuietly();
}

// Monotonically-increasing version counter. Bumped on every markNotesDirty()
// so clients can detect external index changes via the indexVersion field in
// notesIndexPayload() responses and refresh without polling.
let notesIndexVersion = 1;
export function notesIndexVersionValue() { return notesIndexVersion; }

// Registry of files the server wrote itself (atomic renames). The watcher
// ignores self-writes within a 2-second window to avoid triggering redundant
// re-scans immediately after save. Capped at 256 entries to prevent unbounded growth.
const recentSelfWrites = new Map();
export function noteSelfWrite(file) {
  recentSelfWrites.set(file, Date.now());
  if (recentSelfWrites.size > 256) {
    // Delete the oldest entry
    const oldest = recentSelfWrites.keys().next().value;
    recentSelfWrites.delete(oldest);
  }
}
export function noteSelfWriteRecently(file, windowMs = 2000) {
  const ts = recentSelfWrites.get(file);
  if (!ts) return false;
  if (Date.now() - ts > windowMs) { recentSelfWrites.delete(file); return false; }
  return true;
}

// Whether a vault-relative path is eligible to affect the note index.
// Mirrors the filter in walkFiles so the watcher and the scanner agree.
export function notePathWatchRelevant(relPath) {
  if (!relPath) return false;
  const parts = String(relPath).replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.some((p) => excludedDirs.has(p) || p.startsWith("."))) return false;
  const name = parts[parts.length - 1] || "";
  const dot = name.lastIndexOf(".");
  return dot >= 0 && noteExts.has(name.slice(dot).toLowerCase());
}

export function markNotesDirty(file = "") {
  notesIndexVersion++;
  pathSuggestionDirListingCache.clear();
  notesSnapshotDirty = true;
  if (file && inside(file, noteScanRoot)) {
    dirtyNoteFiles.add(file);
    noteCache.delete(file);
    forgetAgendaFileCache(file);
  } else {
    notesSnapshotFullDirty = true;
    dirtyNoteFiles = new Set();
    forgetAgendaFileCache();
  }
}

function notePathMayAffectIndex(file) {
  if (!file) return true;
  const dot = file.lastIndexOf(".");
  return dot >= 0 && noteExts.has(file.slice(dot).toLowerCase());
}

async function noteFromFileForIndex(file) {
  try {
    const info = await stat(file);
    if (!info.isFile()) return null;
    const cached = noteCache.get(file);
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
      return { ...cached.note, backlinks: [] };
    }
    const persistent = await cachedNoteEntryForFile(file, info);
    if (persistent) {
      noteCache.set(file, persistent);
      return { ...persistent.note, backlinks: [] };
    }
    const content = await readFile(file, "utf8");
    const relPath = displayPathForScanRoot(file, noteScanRoot);
    const groupKey = groupKeyFor(file, noteScanRoot);
    const id = idFromContent(file, noteScanRoot, content);
    const roam = hasRoamMeta(content);
    const inlineTags = inlineTagsFromContent(content);
    const leanBlocks = [];
    const note = {
      key: id,
      id,
      title: titleFromContent(file, content),
      file,
      link: relPath,
      path: relPath,
      ext: file.slice(file.lastIndexOf(".") + 1).toLowerCase(),
      kind: kindFromContent(content),
      date: dateFromContent(content),
      groupKey,
      groupLabel: groupLabelFor(groupKey),
      section: groupKey.includes(sep) ? groupKey.split(sep)[0] : groupKey,
      source: sourceFromContent(content),
      project: projectFromContent(content),
      aliases: aliasesFromContent(content),
      summary: summaryFromContent(content),
      tags: tagsFromContent(content),
      inlineTags,
      refs: refsFromContent(content),
      backlinks: [],
      roam,
      domTargets: [],
      leanBlocks,
      standalone: standaloneFile(file),
    };
    note.domTargets = domTargetsFromContent(content, note);
    const planningContent = contentMayHavePlanning(content) ? content : "";
    noteCache.set(file, {
      mtimeMs: info.mtimeMs,
      size: info.size,
      note,
      todos: planningContent ? null : [],
      planning: planningContent ? null : { todos: [], projects: [], milestones: [], clocks: [], nodes: [] },
      planningContent,
      planningNeedsRead: false,
    });
    rememberAgendaFileCache(file, noteCache.get(file));
    return { ...note };
  } catch {
    noteCache.delete(file);
    forgetAgendaFileCache(file);
    return null;
  }
}

function resolveNoteRelationships(notes) {
  const uniqueNotes = [...notes.reduce((map, note) => {
    map.set(note.id, preferNote({ ...note, backlinks: [] }, map.get(note.id)));
    return map;
  }, new Map()).values()];
  const refsByKey = serverNoteReferenceIndex(uniqueNotes);
  for (const note of uniqueNotes) {
    const resolved = [];
    for (const ref of note.refs || []) {
      const target = refsByKey.get(canonicalServerNoteRef(ref));
      if (!target || target.id === note.id) continue;
      resolved.push(target.id);
      target.backlinks.push(note.id);
    }
    note.refs = [...new Set(resolved)].sort();
  }
  for (const note of uniqueNotes) note.backlinks = [...new Set(note.backlinks)].sort();
  return uniqueNotes.sort((a, b) => a.title.localeCompare(b.title));
}

function sortedUniqueStrings(values) {
  return [...new Set(values.map((value) => String(value || "")).filter(Boolean))].sort();
}

function sameStringList(a = [], b = []) {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

function noteRefIdentityKeys(note) {
  return sortedUniqueStrings(serverNoteRefValues(note).map((value) => canonicalServerNoteRef(value)));
}

function buildRelationshipCache(resolvedNotes) {
  const targetByCanonical = new Map();
  const refKeysById = new Map();
  for (const note of resolvedNotes) {
    refKeysById.set(note.id, noteRefIdentityKeys(note));
    for (const value of serverNoteRefValues(note)) {
      const key = canonicalServerNoteRef(value);
      if (key && !targetByCanonical.has(key)) targetByCanonical.set(key, note.id);
    }
  }
  return { targetByCanonical, refKeysById };
}

function resolvedRefsForRawNote(note, targetByCanonical) {
  const resolved = [];
  for (const ref of note.refs || []) {
    const targetId = targetByCanonical.get(canonicalServerNoteRef(ref));
    if (targetId && targetId !== note.id) resolved.push(targetId);
  }
  return sortedUniqueStrings(resolved);
}

function sortResolvedNotes(notes) {
  for (const note of notes) {
    note.refs = sortedUniqueStrings(note.refs || []);
    note.backlinks = sortedUniqueStrings(note.backlinks || []);
  }
  return notes.sort((a, b) => a.title.localeCompare(b.title));
}

function patchResolvedRelationships(previousResolved, dirtyFiles, dirtyRawNotes) {
  if (!notesRelationshipCache) return null;
  const oldByFile = new Map(previousResolved.map((note) => [note.file, note]));
  const nextById = new Map(previousResolved.map((note) => [note.id, cloneNote(note)]));
  const rawByFile = new Map(dirtyRawNotes.filter(Boolean).map((note) => [note.file, note]));

  for (const file of dirtyFiles) {
    const oldNote = oldByFile.get(file);
    const rawNote = rawByFile.get(file);
    if (!oldNote || !rawNote || oldNote.id !== rawNote.id) return null;
    const oldKeys = notesRelationshipCache.refKeysById.get(oldNote.id) ?? noteRefIdentityKeys(oldNote);
    const newKeys = noteRefIdentityKeys(rawNote);
    if (!sameStringList(oldKeys, newKeys)) return null;
  }

  for (const file of dirtyFiles) {
    const oldNote = oldByFile.get(file);
    const rawNote = rawByFile.get(file);
    const previous = nextById.get(oldNote.id);
    if (!previous) return null;

    const oldRefs = new Set(previous.refs || []);
    const newRefs = new Set(resolvedRefsForRawNote(rawNote, notesRelationshipCache.targetByCanonical));
    const nextNote = { ...cloneNote(rawNote), refs: [...newRefs], backlinks: [...(previous.backlinks || [])] };

    for (const ref of oldRefs) {
      if (newRefs.has(ref)) continue;
      const target = nextById.get(ref);
      if (target) target.backlinks = (target.backlinks || []).filter((id) => id !== oldNote.id);
    }
    for (const ref of newRefs) {
      if (oldRefs.has(ref)) continue;
      const target = nextById.get(ref);
      if (target && !(target.backlinks || []).includes(oldNote.id)) target.backlinks.push(oldNote.id);
    }
    nextById.set(oldNote.id, nextNote);
  }

  return sortResolvedNotes([...nextById.values()]);
}

function rememberNoteSnapshots(rawNotes, resolvedNotes) {
  notesRawSnapshot = rawNotes;
  notesSnapshot = resolvedNotes;
  notesRelationshipCache = buildRelationshipCache(resolvedNotes);
  notesSnapshotFingerprint = computeNotesSnapshotFingerprint(rawNotes);
}

async function walkFiles(root, accept) {
  const files = [];
  async function walk(dir) {
    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".emacs.d") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!excludedDirs.has(entry.name)) await walk(full);
      } else if (entry.isFile() && accept(full, entry.name)) {
        files.push(full);
      }
    }
  }
  await walk(root);
  return files;
}

async function mapLimit(items, limit, mapper) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}

// Coalesces concurrent scanNotes() callers onto one in-flight scan instead of
// letting them race and interleave mutations of the shared snapshot/cache
// state. scanNotesOnce() claims the dirty state at its *start* (not its end)
// so a markNotesDirty() that lands mid-scan is never lost: it re-populates
// dirtyNoteFiles/notesSnapshotFullDirty, which the *next* loop iteration (or
// the next external scanNotes() call) picks up.
let scanNotesInFlight = null;

export async function scanNotes() {
  for (;;) {
    if (noteCacheRoot !== noteScanRoot) {
      noteCacheRoot = noteScanRoot;
      noteCache = new Map();
      notesSnapshotRoot = noteScanRoot;
      notesSnapshot = null;
      notesRawSnapshot = null;
      notesRelationshipCache = null;
      notesSnapshotFingerprint = "";
      notesSnapshotDirty = true;
      notesSnapshotFullDirty = true;
      dirtyNoteFiles = new Set();
    }
    if (notesSnapshotRoot === noteScanRoot && notesSnapshot && !notesSnapshotDirty) {
      return cloneNotes(notesSnapshot);
    }
    if (scanNotesInFlight) {
      try { await scanNotesInFlight; } catch {}
      continue;
    }
    notesSnapshotRoot = noteScanRoot;
    scanNotesInFlight = scanNotesOnce();
    try {
      return await scanNotesInFlight;
    } finally {
      scanNotesInFlight = null;
    }
  }
}

async function scanNotesOnce() {
  const claimedFullDirty = notesSnapshotFullDirty;
  const claimedDirtyFiles = dirtyNoteFiles;
  notesSnapshotFullDirty = false;
  dirtyNoteFiles = new Set();
  notesSnapshotDirty = false;

  try {
    if (notesSnapshot && !claimedFullDirty && claimedDirtyFiles.size > 0) {
      const dirty = [...claimedDirtyFiles].filter((file) => notePathMayAffectIndex(file));
      const persistentCache = await ensureAgendaPersistentCache();
      if (persistentCache && dirty.length > 0) {
        for (const file of dirty) persistentCache.files.delete(file);
        persistentCache.payloads.clear();
        agendaPersistentCacheDirty = true;
      }
      const dirtySet = new Set(dirty.map(canonicalExistingPath));
      const rawNotes = cloneNotes(notesRawSnapshot || [])
        .filter((note) => !dirtySet.has(canonicalExistingPath(note.file)));
      const dirtyNotes = [];
      for (const file of dirty) {
        const note = await noteFromFileForIndex(file);
        if (note) {
          rawNotes.push(note);
          dirtyNotes.push(note);
        }
      }
      const sorted = patchResolvedRelationships(notesSnapshot, dirty, dirtyNotes)
        ?? resolveNoteRelationships(rawNotes);
      rememberNoteSnapshots(rawNotes, sorted);
      await flushAgendaPersistentCacheQuietly();
      return cloneNotes(sorted);
    }

    const files = await walkFiles(noteScanRoot, (file) => {
      const dot = file.lastIndexOf(".");
      return dot >= 0 && noteExts.has(file.slice(dot).toLowerCase());
    });
    const notes = [];
    const seen = new Set(files);
    const scanned = await mapLimit(files, scanConcurrency, async (file) => {
      return noteFromFileForIndex(file);
    });
    for (const note of scanned) if (note) notes.push(note);
    for (const file of noteCache.keys()) {
      if (!seen.has(file)) noteCache.delete(file);
    }
    if (agendaPersistentCache && agendaCacheEnabled()) {
      for (const file of agendaPersistentCache.files.keys()) {
        if (!seen.has(file)) {
          agendaPersistentCache.files.delete(file);
          agendaPersistentCacheDirty = true;
        }
      }
    }
    const sorted = resolveNoteRelationships(notes);
    rememberNoteSnapshots(notes, sorted);
    await flushAgendaPersistentCacheQuietly();
    return cloneNotes(sorted);
  } catch (err) {
    notesSnapshotDirty = true;
    if (claimedFullDirty) {
      notesSnapshotFullDirty = true;
      dirtyNoteFiles = new Set();
    } else {
      for (const f of claimedDirtyFiles) dirtyNoteFiles.add(f);
    }
    throw err;
  }
}

export async function scanRoamNotes() {
  return await withNoteScanRoot(noteRoot, async () => scanNotes());
}

function normalizeArgDates(args) {
  if (!args || typeof args !== "object") return args;
  const out = { ...args };
  for (const key of Object.keys(out)) {
    if ((DATE_KEYS.has(key) || key === "end" || key === "finish") && typeof out[key] === "string") {
      const canon = normalizeDateValue(out[key]);
      if (canon) out[key] = canon;
    }
  }
  return out;
}

function planningArgsWithNoteDefaults(attrs, note) {
  const args = { ...(attrs || {}) };
  const project = String(note?.project || "").trim();
  if (project && !args.project && !args.proj) args.project = project;
  return normalizeArgDates(args);
}

export function extractTodos(content, note, updatedAt) {
  const todos = [];
  const planningSource = maskMetaSummaryContent(content);
  const lineStarts = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") lineStarts.push(i + 1);
  }
  const lineFor = (index) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (lineStarts[mid] <= index) lo = mid + 1;
      else hi = mid - 1;
    }
    return Math.max(0, hi) + 1;
  };
  for (const command of scanPlanningNodes(planningSource, { kind: "todo" })) {
    const source = content.slice(command.span.from, command.span.to);
    const text = String(command.title || "").trim();
    const status = normalizeTodoStatus(command.status);
    const args = planningArgsWithNoteDefaults(command.attrs, note);
    const line = lineFor(command.span.from);
    const lineStart = lineStarts[line - 1] || 0;
    const lineEnd = content.indexOf("\n", lineStart);
    const rawLine = content.slice(lineStart, lineEnd < 0 ? content.length : lineEnd).trim();
    todos.push({
      id: args.id ? `#${args.id}` : `${note.file}:${command.span.from}`,
      command: command.kind,
      status,
      text,
      args,
      canon: canonicalTodoArgs(args),
      meta: command.attrsRaw,
      ddl: args.ddl || "",
      source,
      index: command.span.from,
      line,
      column: command.span.column,
      context: rawLine,
      file: note.file,
      path: note.path,
      noteKey: note.key,
      noteId: note.id,
      roamId: note.id,
      noteTitle: note.title,
      noteDate: note.date || "",
      tags: Array.isArray(note.tags) ? [...note.tags] : [],
      inlineTags: Array.isArray(note.inlineTags) ? [...note.inlineTags] : [],
      groupKey: note.groupKey || "",
      groupLabel: note.groupLabel || "",
      parentFile: note.path || note.file || "",
      parentTitle: note.title || "",
      updatedAt,
    });
  }
  return todos;
}

export function extractPlanningItems(content, note, updatedAt) {
  const nodes = scanPlanningNodes(maskMetaSummaryContent(content));
  const todos = extractTodos(content, note, updatedAt);
  const todoByIndex = new Map(todos.map((todo) => [todo.index, todo]));
  const projects = [];
  const milestones = [];
  const clocks = [];
  for (const node of nodes) {
    if (node.kind === "todo" || node.kind === "itodo") continue;
    const args = planningArgsWithNoteDefaults(node.attrs || {}, note);
    const canon = canonicalTodoArgs(args);
    const base = {
      id: args.id ? `#${args.id}` : `${note.file}:${node.span.from}`,
      kind: node.kind,
      status: node.status || "",
      text: node.title || "",
      title: node.title || "",
      args,
      canon,
      meta: node.attrsRaw || "",
      source: node.raw,
      index: node.span.from,
      line: node.span.line,
      column: node.span.column,
      file: note.file,
      path: note.path,
      noteKey: note.key,
      noteId: note.id,
      roamId: note.id,
      noteTitle: note.title,
      tags: Array.isArray(note.tags) ? [...note.tags] : [],
      inlineTags: Array.isArray(note.inlineTags) ? [...note.inlineTags] : [],
      updatedAt,
      diagnostics: node.diagnostics || [],
    };
    if (node.kind === "project") projects.push({ ...base, status: node.status || "active" });
    else if (node.kind === "milestone") milestones.push(base);
    else if (node.kind === "clock") clocks.push(base);
  }
  return { todos: todos.map((todo) => todoByIndex.get(todo.index) || todo), projects, milestones, clocks, nodes };
}

function todoStatusSource(status, commandName = "todo") {
  const normalized = normalizeTodoStatus(status);
  const command = String(commandName || "todo").toLowerCase() === "itodo" ? "itodo" : "todo";
  return normalized === "todo" ? `@@${command} ` : `@@${command}(${normalized}) `;
}

function replaceTodoStatusInSource(source, status) {
  const text = String(source || "");
  const match = text.match(/^@@(todo|itodo)(?:\([^)\n]*\))?[ \t]+/i);
  if (match) {
    return text.replace(/^@@(?:todo|itodo)(?:\([^)\n]*\))?[ \t]+/i, todoStatusSource(status, match[1]));
  }
  return text;
}

const TODO_PATCH_ARG_KEYS = new Set(["priority", "due", "scheduled", "repeat"]);

function bodyHasOwn(body, key) {
  return Object.prototype.hasOwnProperty.call(body || {}, key);
}

function normalizeTodoPatchValue(key, value) {
  if (value === null || value === undefined || value === false) return "";
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (key === "priority") {
    const priority = raw.toUpperCase();
    return /^[A-Z]$/.test(priority) ? priority : "";
  }
  if (DATE_KEYS.has(key)) return normalizeDateValue(raw) || raw;
  return raw;
}

function serializeTodoArgValue(value) {
  const text = String(value || "");
  if (!text) return "";
  return /[\s,;{}[\]"']/.test(text) ? JSON.stringify(text) : text;
}

function serializeTodoArgs(args) {
  const entries = Object.entries(args || {})
    .filter(([, value]) => String(value || "").trim())
    .sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return "";
  return `{${entries.map(([key, value]) => `${key}=${serializeTodoArgValue(value)}`).join(", ")}}`;
}

function replaceTodoArgsInSource(source, argsRaw, nextArgsRaw) {
  const text = String(source || "");
  const argsText = String(argsRaw || "");
  const nextText = String(nextArgsRaw || "");
  if (argsText) {
    const at = text.lastIndexOf(argsText);
    if (at >= 0) {
      const prefix = text.slice(0, at).trimEnd();
      return nextText ? `${prefix}${text.slice(prefix.length, at)}${nextText}${text.slice(at + argsText.length)}` : `${prefix}${text.slice(at + argsText.length)}`;
    }
  }
  return nextText ? `${text.trimEnd()}${text.endsWith(" ") || text.endsWith("\t") ? "" : " "}${nextText}` : text;
}

function patchTodoSource(source, body = {}) {
  let next = bodyHasOwn(body, "status")
    ? replaceTodoStatusInSource(source, body.status || "todo")
    : String(source || "");
  const patchKeys = [...TODO_PATCH_ARG_KEYS].filter((key) => bodyHasOwn(body, key));
  if (patchKeys.length === 0) return next;
  const command = scanPlanningNodes(next, { kind: "todo" })[0];
  if (!command || command.span.from !== 0) return next;
  const args = { ...(command.attrs || {}) };
  for (const key of patchKeys) {
    const value = normalizeTodoPatchValue(key, body[key]);
    if (value) args[key] = value;
    else delete args[key];
  }
  return replaceTodoArgsInSource(next, command.attrsRaw || "", serializeTodoArgs(args));
}

// Shared todo locator: index+source match, then a line-anchored regex scan,
// then a full re-extract match by id/source/text. Used by updateTodoStatus
// and the newer patchTodo/completeTodo so both tolerate unsaved editor drift
// the same way.
function locateTodoInContent(content, body, file) {
  const source = String(body.source || "");
  const wantedText = String(body.text || "");
  const hasIndex = body.index !== undefined && body.index !== null && String(body.index) !== "";
  const rawIndex = hasIndex ? Number(body.index) : NaN;
  let from = -1;
  let to = -1;

  if (Number.isInteger(rawIndex) && rawIndex >= 0 && rawIndex < content.length) {
    const lineStart = content.lastIndexOf("\n", rawIndex - 1) + 1;
    const lineEnd = content.indexOf("\n", rawIndex);
    const line = content.slice(lineStart, lineEnd < 0 ? content.length : lineEnd);
    const match = line.match(/@@(?:todo|itodo)(?:\([^)\n]*\))?[ \t]+/i);
    if (match) {
      const candidateFrom = lineStart + (match.index || 0);
      // Always parse the actual node at this position (unbounded — a
      // block-shape node can span multiple lines) instead of trusting a raw
      // `source`-length substring compare. A stale `source` can be an exact
      // PREFIX of the current node text — e.g. a prior patch appended a
      // trailing `{...}` block — and a plain `content.slice(candidateFrom,
      // candidateFrom + source.length) === source` check would accept that
      // truncated match and silently drop everything after it on write.
      const commands = scanPlanningNodes(content.slice(candidateFrom), { kind: "todo" });
      if (commands.length > 0 && commands[0].span.from === 0) {
        const candidateTo = candidateFrom + commands[0].span.to;
        const nodeRaw = content.slice(candidateFrom, candidateTo);
        // A text hint is the more stable signal — it survives any edit to
        // the node's attrs (including one that makes `source` stale), so it
        // wins whenever provided; an unchecked position-only hit previously
        // let a drifted `index` silently patch a *different* todo that now
        // happens to sit on that line. With neither hint, preserve the old
        // lenient index-only behavior.
        const ok = wantedText ? (commands[0].title || "") === wantedText : (!source || nodeRaw === source);
        if (ok) {
          from = candidateFrom;
          to = candidateTo;
        }
      }
    }
  }

  if (from < 0 || to <= from) {
    const todos = extractTodos(content, { file, path: displayPathForFile(file), key: "", id: "", title: "" }, 0);
    const wantedId = String(body.id || "");
    const match = todos.find((todo) =>
      (wantedId && todo.id === wantedId)
      || (source && todo.source === source)
      || (wantedText && todo.text === wantedText));
    if (match) {
      from = match.index;
      to = match.index + match.source.length;
    }
  }

  return from >= 0 && to > from ? { from, to } : null;
}

async function updateTodoStatusInFile(file, body) {
  const hasMetadataPatch = [...TODO_PATCH_ARG_KEYS].some((key) => bodyHasOwn(body, key));
  const shouldPatchStatus = bodyHasOwn(body, "status") || !hasMetadataPatch;
  const status = shouldPatchStatus ? normalizeTodoStatus(body.status || "done") : "";
  const content = await readFile(file, "utf8");
  const loc = locateTodoInContent(content, body, file);
  if (!loc) {
    const err = new Error("Todo source was not found");
    err.statusCode = 404;
    throw err;
  }
  const { from, to } = loc;

  const oldSource = content.slice(from, to);
  const patchBody = shouldPatchStatus ? { ...body, status } : body;
  const nextSource = patchTodoSource(oldSource, patchBody);
  if (nextSource === oldSource) {
    let mtimeMs = 0;
    try { mtimeMs = (await stat(file)).mtimeMs; } catch {}
    return { type: "todo-updated", ok: true, file, status: status || normalizeTodoStatus(body.status || ""), changed: false, from, to, source: oldSource, mtimeMs };
  }

  await atomicWriteFile(file, content.slice(0, from) + nextSource + content.slice(to), "utf8");
  markNotesDirty(file);
  scheduleRoamDbSync(null, file);
  let mtimeMs = 0;
  try { mtimeMs = (await stat(file)).mtimeMs; } catch {}
  return { type: "todo-updated", ok: true, file, status: status || normalizeTodoStatus(body.status || ""), changed: true, from, to, source: oldSource, nextSource, mtimeMs };
}

// Serialized against editor saves and every other agenda mutation on the
// same file via enqueueSaveWrite — the whole read/locate/write cycle runs
// inside the queue so a concurrent editor save can never interleave with it.
export async function updateTodoStatus(body = {}) {
  const file = safeOpenFile(body.file || "");
  return enqueueSaveWrite(file, () => updateTodoStatusInFile(file, body));
}

function contentMayHavePlanning(content) {
  return /@@(?:todo|itodo|project|milestone|clock)(?:\s*\(|[ \t]+)/i.test(String(content || ""));
}

// Parses `cached.planningContent` once (via `extractPlanningItems`, which
// itself computes todos) and memoizes both `cached.todos` and
// `cached.planning` so neither this nor `planningItemsForNote` ever
// re-parses the same unchanged note.
function parseAndCachePlanning(cached, note) {
  const planning = extractPlanningItems(cached.planningContent, note, cached.mtimeMs || 0);
  cached.planning = planning;
  cached.todos = planning.todos;
  cached.planningContent = "";
  cached.planningNeedsRead = false;
  rememberAgendaFileCache(note.file, cached);
  return planning;
}

async function readAndCachePlanning(cached, note) {
  const info = await stat(note.file);
  const content = await readFile(note.file, "utf8");
  const planning = extractPlanningItems(content, note, info.mtimeMs);
  cached.mtimeMs = info.mtimeMs;
  cached.size = info.size;
  cached.planning = planning;
  cached.todos = planning.todos;
  cached.planningContent = "";
  cached.planningNeedsRead = false;
  rememberAgendaFileCache(note.file, cached);
  await flushAgendaPersistentCacheQuietly();
  return planning;
}

async function todosForNote(note) {
  const cached = note.file ? noteCache.get(note.file) : null;
  if (cached) {
    if (Array.isArray(cached.todos)) return cached.todos.map((todo) => ({ ...todo }));
    if (typeof cached.planningContent === "string" && cached.planningContent) {
      return parseAndCachePlanning(cached, note).todos.map((todo) => ({ ...todo }));
    }
    if (cached.planningNeedsRead) {
      try {
        return (await readAndCachePlanning(cached, note)).todos.map((todo) => ({ ...todo }));
      } catch {
        return [];
      }
    }
    cached.todos = [];
    cached.planningNeedsRead = false;
    return [];
  }

  try {
    const info = await stat(note.file);
    const content = await readFile(note.file, "utf8");
    return extractTodos(content, note, info.mtimeMs).map((todo) => ({ ...todo }));
  } catch {
    return [];
  }
}

async function scanTodos() {
  const scanned = await scanNotes();
  const todoGroups = await mapLimit(scanned, scanConcurrency, async (note) => {
    return todosForNote(note);
  });
  const todos = todoGroups.flat();
  return todos.sort((a, b) => {
    const statusRank = { blocked: 0, doing: 1, todo: 2, done: 3, cancelled: 4 };
    return (statusRank[a.status] ?? 9) - (statusRank[b.status] ?? 9)
      || b.updatedAt - a.updatedAt
      || String(a.noteTitle).localeCompare(String(b.noteTitle));
  });
}

function clonePlanningGroup(group) {
  return {
    todos: (group.todos || []).map((todo) => ({ ...todo })),
    projects: (group.projects || []).map((project) => ({ ...project })),
    milestones: (group.milestones || []).map((milestone) => ({ ...milestone })),
    clocks: (group.clocks || []).map((clock) => ({ ...clock })),
    nodes: group.nodes || [],
  };
}

async function planningItemsForNote(note) {
  try {
    const cached = note.file ? noteCache.get(note.file) : null;
    if (cached) {
      if (cached.planning) return clonePlanningGroup(cached.planning);
      if (typeof cached.planningContent === "string" && cached.planningContent) {
        return clonePlanningGroup(parseAndCachePlanning(cached, note));
      }
      if (cached.planningNeedsRead) {
        return clonePlanningGroup(await readAndCachePlanning(cached, note));
      }
      cached.planning = { todos: [], projects: [], milestones: [], clocks: [], nodes: [] };
      cached.todos = [];
      cached.planningNeedsRead = false;
      rememberAgendaFileCache(note.file, cached);
      return clonePlanningGroup(cached.planning);
    }
    const info = await stat(note.file);
    const content = await readFile(note.file, "utf8");
    return extractPlanningItems(content, note, info.mtimeMs);
  } catch {
    return { todos: [], projects: [], milestones: [], clocks: [], nodes: [] };
  }
}

async function scanPlanningItems() {
  const scanned = await scanNotes();
  const groups = await mapLimit(scanned, scanConcurrency, async (note) => planningItemsForNote(note));
  return {
    todos: groups.flatMap((group) => group.todos || []),
    projects: groups.flatMap((group) => group.projects || []),
    milestones: groups.flatMap((group) => group.milestones || []),
    clocks: groups.flatMap((group) => group.clocks || []),
    nodes: groups.flatMap((group) => group.nodes || []),
  };
}

// ---------------------------------------------------------------------------
// Agenda engine: repeaters, dependency resolution (no ids — text refs), the
// urgency/sort formula, day-bucketed view-model, and canonical-key patching
// (priority/scheduled/deadline/repeat/after) that writes straight back into
// the @@todo line. See docs/agenda.md.
// ---------------------------------------------------------------------------

const CLOSED_STATUSES = new Set(["done", "cancelled"]);

function normalizeTitleKey(title) {
  return String(title || "").trim().toLowerCase();
}

function matchTodoInScope(scopeTodos, needleText, excludeId) {
  const needle = needleText.trim().toLowerCase();
  const candidates = scopeTodos.filter((t) => t.id !== excludeId);
  let hits = candidates.filter((t) => String(t.text || "").trim().toLowerCase() === needle);
  if (hits.length === 1) return { tier: "exact", hits };
  if (hits.length > 1) return { tier: "ambiguous", hits };
  hits = candidates.filter((t) => String(t.text || "").trim().toLowerCase().startsWith(needle));
  if (hits.length === 1) return { tier: "prefix", hits };
  if (hits.length > 1) return { tier: "ambiguous", hits };
  hits = candidates.filter((t) => String(t.text || "").trim().toLowerCase().includes(needle));
  if (hits.length === 1) return { tier: "substring", hits };
  if (hits.length > 1) return { tier: "ambiguous", hits };
  return { tier: "none", hits: [] };
}

// Builds an id -> item map from already-extracted planning items (todos,
// or todos+projects+... combined), reassigning any item whose stable `#id`
// collides with an earlier one back to its positional `file:offset` id and
// recording a `duplicate-id` lint — a stable id is only useful while it's
// unique, and a typo'd duplicate must never merge two different items.
function buildIdIndexWithDedup(items, lints) {
  const byId = new Map();
  for (const item of items) {
    if (item.id.startsWith("#") && byId.has(item.id)) {
      const original = item.id;
      item.id = `${item.file}:${item.index}`;
      lints.push({ todoId: item.id, file: item.file, line: item.line, kind: "duplicate-id", ref: original, message: `Duplicate id "${original}"; fell back to a positional id` });
    }
    byId.set(item.id, item);
  }
  return byId;
}

// Resolves the dep-refs in `rawValue` (an `after`/`blocks` attr value)
// against `titleIndex`/`todos`/`byId`, pushing broken/ambiguous-ref lints as
// it goes. Returns the resolved target todo ids (empty on any lint).
function resolveDepRefTargets(todo, rawValue, titleIndex, todos, lints, via, byId) {
  const targets = [];
  for (const ref of parseDepRefs(rawValue)) {
    if (ref.id) {
      const target = byId.get(`#${ref.id}`);
      if (target && target.id !== todo.id) targets.push(target.id);
      else lints.push({ todoId: todo.id, file: todo.file, line: todo.line, kind: "broken-ref", ref: ref.raw, via, message: `No todo with id "${ref.raw}"` });
      continue;
    }
    let scopeFiles;
    if (ref.noteTitle) {
      const files = titleIndex.get(normalizeTitleKey(ref.noteTitle));
      if (!files || files.size === 0) {
        lints.push({ todoId: todo.id, file: todo.file, line: todo.line, kind: "broken-ref", ref: ref.raw, via, message: `No note titled "${ref.noteTitle}"` });
        continue;
      }
      if (files.size > 1) {
        lints.push({ todoId: todo.id, file: todo.file, line: todo.line, kind: "ambiguous-note", ref: ref.raw, via, message: `Multiple notes titled "${ref.noteTitle}"` });
        continue;
      }
      scopeFiles = [...files];
    } else {
      scopeFiles = [todo.file];
    }
    const scopeTodos = todos.filter((t) => scopeFiles.includes(t.file));
    const { tier, hits } = matchTodoInScope(scopeTodos, ref.text, todo.id);
    if (tier === "none") {
      lints.push({ todoId: todo.id, file: todo.file, line: todo.line, kind: "broken-ref", ref: ref.raw, via, message: `No matching todo for "${ref.text}"` });
    } else if (tier === "ambiguous") {
      lints.push({
        todoId: todo.id,
        file: todo.file,
        line: todo.line,
        kind: "ambiguous-ref",
        ref: ref.raw,
        via,
        message: `Multiple todos match "${ref.text}"`,
        candidates: hits.map((h) => ({ id: h.id, text: h.text })),
      });
    } else {
      targets.push(hits[0].id);
    }
  }
  return targets;
}

// Decorates `todos` in place with `deps` (resolved target ids, from both
// `after` — forward deps declared on this todo — and `blocks` — reverse
// deps declared on the *target* todo), `effectiveStatus`, and `blockedBy`;
// returns `{ lints }` for broken/ambiguous refs. Broken/ambiguous refs never
// block — a typo must not freeze a task, so they only ever surface as lint
// entries.
export function resolveTodoDeps(todos) {
  const lints = [];
  const titleIndex = new Map();
  for (const todo of todos) {
    const key = normalizeTitleKey(todo.noteTitle);
    if (!key) continue;
    if (!titleIndex.has(key)) titleIndex.set(key, new Set());
    titleIndex.get(key).add(todo.file);
  }

  for (const todo of todos) todo.deps = [];

  const byId = buildIdIndexWithDedup(todos, lints);

  for (const todo of todos) {
    if (!todo.canon?.after) continue;
    todo.deps.push(...resolveDepRefTargets(todo, todo.canon.after, titleIndex, todos, lints, "after", byId));
  }

  for (const todo of todos) {
    if (!todo.canon?.blocks) continue;
    const targetIds = resolveDepRefTargets(todo, todo.canon.blocks, titleIndex, todos, lints, "blocks", byId);
    for (const targetId of targetIds) {
      const target = byId.get(targetId);
      if (target && !target.deps.includes(todo.id)) target.deps.push(todo.id);
    }
  }

  for (const todo of todos) {
    todo.deps = [...new Set(todo.deps)];
    const openDeps = todo.deps.filter((id) => {
      const dep = byId.get(id);
      return dep && !CLOSED_STATUSES.has(dep.status);
    });
    if ((todo.status === "todo" || todo.status === "doing") && openDeps.length > 0) {
      todo.effectiveStatus = "blocked";
      todo.blockedBy = openDeps;
    } else {
      todo.effectiveStatus = todo.status;
      todo.blockedBy = [];
    }
  }

  return { lints };
}

const TODO_PRIO_WEIGHT = { A: 4, B: 3, C: 2, D: 1, E: 0, F: -1 };

// Adapted from org-agenda's urgency sort (our own implementation, not copied
// code): priority dominates, deadline proximity adds a bounded bonus that
// ramps up inside the warning window and further once overdue, `doing` gets
// a small nudge, and a *computed* blocked state is pushed to the bottom.
export function todoUrgency(todo, todayMs = Date.now()) {
  const prio = todo.canon?.prio || "D";
  const prioWeight = TODO_PRIO_WEIGHT[prio] ?? TODO_PRIO_WEIGHT.D;
  let dateScore = 0;
  const ddl = todo.canon?.ddl;
  if (ddl) {
    const parsed = parseDateValue(ddl);
    if (parsed) {
      const todayMid = midnightMs(new Date(todayMs));
      const dayMs = 86_400_000;
      const daysLeft = Math.round((parsed.time - todayMid) / dayMs);
      const warnDays = Math.max(1, parseLeadTime(todo.canon?.warn, 14));
      dateScore = daysLeft < 0
        ? 500 + Math.min(-daysLeft, 10) * 100
        : Math.max(0, ((warnDays - daysLeft) * 500) / warnDays);
    }
  }
  const doingBonus = todo.status === "doing" ? 50 : 0;
  const blockedPenalty = todo.effectiveStatus === "blocked" ? 2000 : 0;
  return prioWeight * 1000 + dateScore + doingBonus - blockedPenalty;
}

function sortByUrgency(todos) {
  return [...todos].sort((a, b) =>
    (b.urgency ?? 0) - (a.urgency ?? 0)
    || String(a.canon?.ddl || "").localeCompare(String(b.canon?.ddl || ""))
    || String(a.noteTitle || "").localeCompare(String(b.noteTitle || ""))
    || a.index - b.index);
}

// `time` is the HH:MM time-grid slot when `date` carries a time-of-day
// (e.g. `sche: 2026-07-07 09:30`); untimed entries sort by urgency instead.
function agendaEntry(todo, kind, label, date, dateKey) {
  const parsed = parseDateValue(date);
  const time = parsed && parsed.hasTime ? formatDateValue(parsed.time, true).slice(-5) : null;
  return { kind, label, todoId: todo.id, date, dateKey, time, urgency: todo.urgency ?? 0 };
}

// Projects future occurrences of a repeating ddl/sche forward from `rawDate`
// using plain `+n·unit` stepping (display-only — never the completion-time
// catch-up semantics of `++`/`.+`), for calendar/agenda views. Bounded to
// the `[rangeStartMs, rangeEndMs)` window with a hard iteration guard.
function expandRepeatOccurrences(rawDate, repeaterRaw, rangeStartMs, rangeEndMs) {
  const repeater = parseRepeater(repeaterRaw);
  if (!repeater) return [];
  const stepper = { mode: "+", n: repeater.n, unit: repeater.unit };
  const occurrences = [];
  let current = rawDate;

  // Fast-forward an anchor that predates the window instead of stepping one
  // repeater-period at a time from it — a short-period repeater (e.g. daily)
  // anchored years back would otherwise exhaust the 366-iteration guard
  // below before ever reaching `rangeStartMs`, silently producing zero
  // occurrences. d/w jump arithmetically in one `shiftDate` call (a single
  // multi-day `setDate` jump preserves local wall-clock time across DST the
  // same way the old one-step-at-a-time loop did; ms-based arithmetic would
  // not). m/y still clamp/compound step by step (e.g. `2020-01-31 +1m` ->
  // `03-03` -> ...), so they fast-forward with their own bounded iterative
  // catch-up instead of a closed-form jump.
  const parsedAnchor = parseDateValue(rawDate);
  if (parsedAnchor && parsedAnchor.time < rangeStartMs) {
    if (repeater.unit === "d" || repeater.unit === "w") {
      const stepMs = repeater.n * (repeater.unit === "w" ? 7 : 1) * 86_400_000;
      if (stepMs > 0) {
        const k = Math.max(0, Math.floor((rangeStartMs - parsedAnchor.time) / stepMs) - 1);
        if (k > 0) {
          current = formatDateValue(shiftDate(parsedAnchor.time, k * repeater.n, repeater.unit), parsedAnchor.hasTime);
        }
      }
    } else {
      for (let guard = 0; guard < 2400; guard++) {
        const parsedCurrent = parseDateValue(current);
        const next = applyRepeater(current, stepper);
        const parsedNext = parseDateValue(next);
        if (!parsedCurrent || !parsedNext || parsedNext.time <= parsedCurrent.time) break;
        if (parsedNext.time >= rangeStartMs) break;
        current = next;
      }
    }
  }

  for (let guard = 0; guard < 366; guard++) {
    const parsedCurrent = parseDateValue(current);
    const next = applyRepeater(current, stepper);
    const parsedNext = parseDateValue(next);
    if (!parsedCurrent || !parsedNext || parsedNext.time <= parsedCurrent.time) break;
    if (parsedNext.time >= rangeEndMs) break;
    if (parsedNext.time >= rangeStartMs) {
      occurrences.push({
        date: next,
        dateKey: formatDateValue(parsedNext.time, false),
        time: parsedNext.hasTime ? formatDateValue(parsedNext.time, true).slice(-5) : null,
      });
    }
    current = next;
  }
  return occurrences;
}

function projectSlug(text) {
  return String(text || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "") || "inbox";
}

function inferTodoProject(todo, projects) {
  const explicit = todo.canon?.project || todo.args?.project || todo.args?.proj;
  if (explicit) return String(explicit);
  return inferNearestProject(todo, projects);
}

function inferNearestProject(item, projects) {
  const sameFileProjects = projects
    .filter((project) => project.file === item.file && project.index < item.index)
    .sort((a, b) => b.index - a.index);
  if (sameFileProjects[0]) return projectSlug(sameFileProjects[0].title || sameFileProjects[0].text);
  return "";
}

function inferPlanningProject(item, projects) {
  const explicit = item.canon?.project || item.args?.project || item.args?.proj;
  if (explicit) return String(explicit);
  return inferNearestProject(item, projects);
}

// The project's own identity key, in the same space `inferTodoProject`
// resolves todos into — explicit `project:`/`proj:`, else the slugified
// title.
function projectKeyFor(project) {
  return String(project.canon?.project || project.args?.project || project.args?.proj || projectSlug(project.title || project.text));
}

function detectDependencyCycles(todos) {
  const byId = new Map(todos.map((todo) => [todo.id, todo]));
  const visiting = new Set();
  const visited = new Set();
  const cycles = [];
  function visit(id, stack) {
    if (visiting.has(id)) {
      const at = stack.indexOf(id);
      cycles.push(stack.slice(at).concat(id));
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    const todo = byId.get(id);
    for (const dep of todo?.deps || []) visit(dep, stack.concat(dep));
    visiting.delete(id);
    visited.add(id);
  }
  for (const todo of todos) visit(todo.id, [todo.id]);
  return cycles;
}

// Groups Gantt `tasks` under each @@project's own bar: an explicit
// sche/end(or ddl) on the project itself wins; otherwise the bar spans
// min(children start) .. max(children end). Projects with neither are
// omitted (nothing to draw).
function buildProjectBars(tasks, projects) {
  const byKey = new Map();
  for (const task of tasks) {
    if (!byKey.has(task.project)) byKey.set(task.project, []);
    byKey.get(task.project).push(task);
  }
  const bars = [];
  for (const project of projects) {
    const key = projectKeyFor(project);
    const children = byKey.get(key) || [];
    let start = project.canon?.sche || "";
    let end = project.canon?.end || project.canon?.ddl || "";
    if (!start) start = [...children.map((t) => t.start)].sort()[0] || "";
    if (!end) {
      const ends = [...children.map((t) => t.end)].sort();
      end = ends[ends.length - 1] || "";
    }
    if (!start || !end) continue;
    bars.push({ id: project.id, key, name: project.title || project.text || key, start, end, childTaskIds: children.map((t) => t.id) });
  }
  return bars;
}

// Aggregates open/doing/done/blocked counts, progress, effort, and clocked
// time onto each explicit @@project. Project keys come only from explicit
// project/proj args, file-meta defaults injected into those args, or the
// nearest preceding same-file @@project. A note title is not a project.
// Todos whose project key does not match a known @@project remain visible in
// the agenda/list views, but should not be promoted into synthetic project
// cards.
export function buildProjectModel(projects, todos, clocks) {
  const clockMinutesByTodoId = new Map();
  for (const clock of clocks || []) {
    if (!clock.todoId) continue;
    clockMinutesByTodoId.set(clock.todoId, (clockMinutesByTodoId.get(clock.todoId) || 0) + clockMinutes(clock));
  }

  const emptyEntry = (key) => ({
    id: "",
    key,
    title: key,
    status: "",
    area: "",
    phase: "",
    file: "",
    open: 0,
    doing: 0,
    done: 0,
    cancelled: 0,
    blocked: 0,
    total: 0,
    progress: 0,
    effortMinutes: 0,
    clockedMinutes: 0,
    childTodoIds: [],
  });

  const byKey = new Map();
  for (const project of projects) {
    const key = projectKeyFor(project);
    byKey.set(key, {
      ...emptyEntry(key),
      id: project.id,
      title: project.title || project.text || key,
      status: project.status || "active",
      area: project.canon?.area || "",
      phase: project.canon?.phase || "",
      file: project.file,
    });
  }

  for (const todo of todos) {
    const key = inferTodoProject(todo, projects);
    if (!byKey.has(key)) continue;
    const entry = byKey.get(key);
    entry.total++;
    entry.childTodoIds.push(todo.id);
    if (todo.effectiveStatus === "blocked") entry.blocked++;
    else if (todo.status === "todo") entry.open++;
    else if (todo.status === "doing") entry.doing++;
    else if (todo.status === "done") entry.done++;
    else if (todo.status === "cancelled") entry.cancelled++;
    const effort = todo.canon?.effort ? parseDuration(todo.canon.effort) : null;
    if (effort) entry.effortMinutes += effort;
    entry.clockedMinutes += clockMinutesByTodoId.get(todo.id) || 0;
  }

  const explicitProgressByKey = new Map(projects.map((p) => [projectKeyFor(p), p.canon?.progress]));
  for (const entry of byKey.values()) {
    const explicitProgress = explicitProgressByKey.get(entry.key);
    if (explicitProgress !== undefined) {
      entry.progress = Math.max(0, Math.min(100, Number(explicitProgress) || 0));
    } else {
      const countable = entry.total - entry.cancelled;
      entry.progress = countable > 0 ? Math.round((entry.done / countable) * 100) : 0;
    }
  }

  return [...byKey.values()].sort((a, b) => b.total - a.total || a.title.localeCompare(b.title));
}

function buildGanttModel(todos, projects, milestones) {
  const lints = [];
  const tasks = [];
  const backlog = [];
  for (const todo of todos) {
    const canon = todo.canon || {};
    const start = canon.sche;
    const explicitEnd = canon.end;
    const end = explicitEnd || (start ? canon.ddl : "");
    const displayEnd = explicitEnd || canon.ddl || "";
    const project = inferTodoProject(todo, projects);
    const base = {
      id: todo.id,
      name: todo.text || "(empty todo)",
      project,
      status: todo.effectiveStatus || todo.status,
      source: { file: todo.file, index: todo.index, line: todo.line, source: todo.source, text: todo.text },
      dependencies: Array.isArray(todo.deps) ? todo.deps : [],
      progress: canon.progress !== undefined ? Math.max(0, Math.min(100, Number(canon.progress) || 0)) : (todo.status === "done" ? 100 : 0),
    };
    if (start && end) tasks.push({ ...base, start, end });
    else {
      backlog.push({ ...base, start: start || "", end: displayEnd });
      if (explicitEnd && !start && todo.status !== "done" && todo.status !== "cancelled") {
        lints.push({ todoId: todo.id, file: todo.file, line: todo.line, kind: "missing-gantt-date", ref: todo.text || todo.id || "(empty todo)", message: "Partially scheduled Gantt tasks need both sche/start and end/ddl" });
      }
    }
  }
  const ganttMilestones = [];
  for (const item of milestones || []) {
    const date = item.canon?.date || item.args?.date || item.args?.when;
    if (!date) {
      lints.push({ todoId: item.id, file: item.file, line: item.line, kind: "missing-milestone-date", ref: item.title || item.text || item.id || "Milestone", message: "Milestones need date" });
      continue;
    }
    ganttMilestones.push({
      id: item.id,
      name: item.title || item.text || "Milestone",
      project: inferPlanningProject(item, projects),
      date,
      source: { file: item.file, index: item.index, line: item.line, source: item.source, text: item.text },
    });
  }
  for (const cycle of detectDependencyCycles(todos)) {
    lints.push({ kind: "cycle", ref: cycle.join(" -> "), message: `Dependency cycle: ${cycle.join(" -> ")}` });
  }
  return { tasks, backlog, milestones: ganttMilestones, lanes: buildProjectBars(tasks, projects), lints };
}

// ---------------------------------------------------------------------------
// Clock engine: `@@clock [task-ref]{from, to}` entries reference a todo the
// same way `after`/`blocks` do — the title is a dep-ref (same-file text
// match, or `[[Note]]::text` across files). Aggregates into per-task/
// per-day/per-project totals, compares against a todo's `effort`, and
// exposes the single globally-running clock (a `from` with no `to`) so
// clock-in/out can enforce mutual exclusion.
// ---------------------------------------------------------------------------

// Resolves each clock against `todos`, decorating clocks in place with
// `todoId` (empty when unresolved); returns `{ lints }`. Broken/ambiguous
// refs never drop the clock from aggregation — it still counts toward its
// own file/day, just not toward a specific todo or project. A `task: "#id"`
// attr (written by `clockIn`) is a stable anchor and always wins over the
// title text, which stays human-readable and only used as a fallback for
// clocks nobody has clocked in through the id-aware writer yet.
export function resolveClockRefs(clocks, todos) {
  const lints = [];
  const titleIndex = new Map();
  const byId = new Map(todos.map((t) => [t.id, t]));
  for (const todo of todos) {
    const key = normalizeTitleKey(todo.noteTitle);
    if (!key) continue;
    if (!titleIndex.has(key)) titleIndex.set(key, new Set());
    titleIndex.get(key).add(todo.file);
  }
  for (const clock of clocks) {
    clock.todoId = "";
    const taskRef = clock.args?.task ? parseDepRefs(clock.args.task)[0] : null;
    if (taskRef?.id) {
      const target = byId.get(`#${taskRef.id}`);
      if (target) { clock.todoId = target.id; continue; }
      lints.push({ file: clock.file, line: clock.line, kind: "broken-clock-ref", ref: taskRef.raw, message: `No todo with id "${taskRef.raw}"` });
      continue;
    }
    const [ref] = parseDepRefs(clock.title || clock.text || "");
    if (!ref) continue;
    let scopeFiles;
    if (ref.noteTitle) {
      const files = titleIndex.get(normalizeTitleKey(ref.noteTitle));
      if (!files || files.size === 0) {
        lints.push({ file: clock.file, line: clock.line, kind: "broken-clock-ref", ref: ref.raw, message: `No note titled "${ref.noteTitle}"` });
        continue;
      }
      if (files.size > 1) {
        lints.push({ file: clock.file, line: clock.line, kind: "ambiguous-clock-ref", ref: ref.raw, message: `Multiple notes titled "${ref.noteTitle}"` });
        continue;
      }
      scopeFiles = [...files];
    } else {
      scopeFiles = [clock.file];
    }
    const scopeTodos = todos.filter((t) => scopeFiles.includes(t.file));
    const { tier, hits } = matchTodoInScope(scopeTodos, ref.text, "");
    if (tier === "none") {
      lints.push({ file: clock.file, line: clock.line, kind: "broken-clock-ref", ref: ref.raw, message: `No matching todo for "${ref.text}"` });
    } else if (tier === "ambiguous") {
      lints.push({
        file: clock.file,
        line: clock.line,
        kind: "ambiguous-clock-ref",
        ref: ref.raw,
        message: `Multiple todos match "${ref.text}"`,
        candidates: hits.map((h) => ({ id: h.id, text: h.text })),
      });
    } else {
      clock.todoId = hits[0].id;
    }
  }
  return { lints };
}

// Minutes spent in a clock span; open-ended (`from` with no `to`) is timed
// against now, so a running clock's elapsed time is always current.
function clockMinutes(clock) {
  const fromRaw = clock.args?.from;
  if (!fromRaw) return 0;
  const from = parseDateValue(fromRaw);
  if (!from) return 0;
  const toRaw = clock.args?.to;
  const to = toRaw ? parseDateValue(toRaw) : null;
  const endMs = to ? to.time : Date.now();
  return Math.max(0, Math.round((endMs - from.time) / 60_000));
}

export function buildClockModel(clocks, todos, projects) {
  const todoById = new Map(todos.map((t) => [t.id, t]));
  const byTask = new Map();
  const byDay = new Map();
  const byProject = new Map();
  let running = null;

  for (const clock of clocks) {
    const minutes = clockMinutes(clock);
    if (clock.args?.from && !clock.args?.to && !running) {
      running = { todoId: clock.todoId || "", text: clock.title || clock.text || "", file: clock.file, from: clock.args.from, minutesSoFar: minutes };
    }
    const todo = clock.todoId ? todoById.get(clock.todoId) : null;
    const taskKey = clock.todoId || `${clock.file}:${clock.index}`;
    if (!byTask.has(taskKey)) {
      byTask.set(taskKey, {
        todoId: clock.todoId || "",
        text: todo?.text || clock.title || clock.text || "",
        file: todo?.file || clock.file,
        minutes: 0,
        effortMinutes: todo?.canon?.effort ? (parseDuration(todo.canon.effort) ?? 0) : 0,
      });
    }
    byTask.get(taskKey).minutes += minutes;

    const fromParsed = clock.args?.from ? parseDateValue(clock.args.from) : null;
    if (fromParsed) {
      const dayKey = formatDateValue(midnightMs(new Date(fromParsed.time)), false);
      byDay.set(dayKey, (byDay.get(dayKey) || 0) + minutes);
    }

    const projectKey = todo ? inferTodoProject(todo, projects) : "";
    if (projectKey) byProject.set(projectKey, (byProject.get(projectKey) || 0) + minutes);
  }

  return {
    tasks: [...byTask.values()].sort((a, b) => b.minutes - a.minutes),
    byDay: Object.fromEntries([...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
    byProject: Object.fromEntries([...byProject.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
    running,
  };
}

// Data-quality lints over the raw clock set (vault-wide). These never change
// aggregation — buildClockModel keeps summing every open/overlapping/
// reversed span so logged time is never silently hidden — they only surface
// the underlying data problem so a human notices and fixes the source. Call
// after resolveClockRefs so `clock.todoId` is populated (used to annotate
// each lint with the task it belongs to, when resolved).
function lintClocks(clocks) {
  const lints = [];
  const openClocks = [];
  const spans = [];

  for (const clock of clocks) {
    const fromRaw = clock.args?.from;
    if (!fromRaw) continue;
    const from = parseDateValue(fromRaw);
    if (!from) continue;
    const toRaw = clock.args?.to;
    if (!toRaw) {
      openClocks.push(clock);
      spans.push({ clock, fromMs: from.time, toMs: Date.now() });
      continue;
    }
    const to = parseDateValue(toRaw);
    if (!to) continue;
    if (to.time < from.time) {
      lints.push({
        file: clock.file,
        line: clock.line,
        kind: "reversed-clock-span",
        ref: clock.source,
        todoId: clock.todoId || "",
        message: "Clock ends before it starts (counted as 0 min)",
      });
      continue;
    }
    spans.push({ clock, fromMs: from.time, toMs: to.time });
  }

  if (openClocks.length > 1) {
    const sorted = [...openClocks].sort((a, b) => String(a.args?.from || "").localeCompare(String(b.args?.from || "")));
    for (const clock of sorted.slice(1)) {
      lints.push({
        file: clock.file,
        line: clock.line,
        kind: "multiple-running-clocks",
        ref: clock.source,
        todoId: clock.todoId || "",
        message: "Multiple running clocks; only the first is shown as running",
      });
    }
  }

  const sortedSpans = [...spans].sort((a, b) => a.fromMs - b.fromMs);
  let maxToMs = -Infinity;
  for (const span of sortedSpans) {
    if (span.fromMs < maxToMs) {
      lints.push({
        file: span.clock.file,
        line: span.clock.line,
        kind: "overlapping-clocks",
        ref: span.clock.source,
        todoId: span.clock.todoId || "",
        message: "Overlaps another clock; totals over-count",
      });
    }
    maxToMs = Math.max(maxToMs, span.toMs);
  }

  return lints;
}

// Builds the day-bucketed agenda view-model: SCHEDULED vs DEADLINE
// semantics (with a per-item warning lead time and org-style overdue/sched
// carry-forward onto today), a completion log (for the log view and the
// existing activity heatmap), dependency lints, and the full urgency-sorted
// todo list. Options: `{ from, days = 7 }`; `from` defaults to today.
export async function buildAgenda(body = {}) {
  const includePlanning = body.includePlanning === true || body.includeGantt === true;
  await scanNotes();
  const todayMs = Date.now();
  const todayMid = midnightMs(new Date(todayMs));
  const todayKey = formatDateValue(todayMid, false);
  const cachedPayload = await cachedAgendaPayload(body, todayKey);
  if (cachedPayload) return cachedPayload;

  const planning = includePlanning ? await scanPlanningItems() : null;
  const todos = includePlanning ? planning.todos : await scanTodos();
  const projects = includePlanning ? planning.projects : [];
  const milestones = includePlanning ? planning.milestones : [];
  const clocks = includePlanning ? planning.clocks : [];
  const { lints } = resolveTodoDeps(todos);
  const dayMs = 86_400_000;
  for (const todo of todos) todo.urgency = todoUrgency(todo, todayMs);

  const fromParsed = body.from ? parseDateValue(body.from) : null;
  const fromMs = fromParsed ? midnightMs(new Date(fromParsed.time)) : todayMid;
  const days = Math.max(1, Math.min(90, Number(body.days) || 7));

  const dayBuckets = [];
  for (let i = 0; i < days; i++) {
    const ms = fromMs + i * dayMs;
    dayBuckets.push({ date: formatDateValue(ms, false), ms, entries: [] });
  }
  const bucketByDate = new Map(dayBuckets.map((b) => [b.date, b]));
  const logByDay = {};

  const addLogDate = (dateStr) => {
    const parsed = parseDateValue(dateStr);
    if (!parsed) return;
    const key = formatDateValue(parsed.time, false);
    logByDay[key] = (logByDay[key] || 0) + 1;
  };

  for (const todo of todos) {
    const canon = todo.canon || {};
    if (canon.ddl) {
      const parsed = parseDateValue(canon.ddl);
      if (parsed) {
        const dateKey = formatDateValue(parsed.time, false);
        const daysLeft = Math.round((parsed.time - todayMid) / dayMs);
        const open = !CLOSED_STATUSES.has(todo.status);
        if (daysLeft < 0) {
          if (open) bucketByDate.get(todayKey)?.entries.push(agendaEntry(todo, "overdue", `${-daysLeft} d ago:`, canon.ddl, "ddl"));
        } else {
          bucketByDate.get(dateKey)?.entries.push(agendaEntry(todo, "deadline", daysLeft === 0 ? "Deadline" : `In ${daysLeft} d.`, canon.ddl, "ddl"));
          const warnDays = parseLeadTime(canon.warn, 14);
          if (open && daysLeft > 0 && daysLeft <= warnDays) {
            bucketByDate.get(todayKey)?.entries.push(agendaEntry(todo, "warning", `In ${daysLeft} d.`, canon.ddl, "ddl"));
          }
        }
      }
    }
    if (canon.sche) {
      const parsed = parseDateValue(canon.sche);
      if (parsed) {
        const dateKey = formatDateValue(parsed.time, false);
        if (parsed.time >= todayMid) {
          bucketByDate.get(dateKey)?.entries.push(agendaEntry(todo, "scheduled", "Scheduled", canon.sche, "sche"));
        } else if (!CLOSED_STATUSES.has(todo.status)) {
          const daysLate = Math.round((todayMid - parsed.time) / dayMs);
          bucketByDate.get(todayKey)?.entries.push(agendaEntry(todo, "sched-carry", `Sched ${daysLate}x:`, canon.sche, "sche"));
        }
      }
    }
    if (canon.done) {
      addLogDate(canon.done);
      const parsed = parseDateValue(canon.done);
      if (parsed) {
        const key = formatDateValue(parsed.time, false);
        bucketByDate.get(key)?.entries.push(agendaEntry(todo, "log", "Closed", canon.done, "done"));
      }
    }
    if (canon.log) {
      for (const raw of String(canon.log).split("&")) {
        const d = raw.trim();
        if (d && d !== canon.done) addLogDate(d);
      }
    }
    if (canon.repeat && !CLOSED_STATUSES.has(todo.status)) {
      const rangeEndMs = fromMs + days * dayMs;
      for (const [anchorDate, kind] of [[canon.ddl, "deadline"], [canon.sche, "scheduled"]]) {
        if (!anchorDate) continue;
        for (const occurrence of expandRepeatOccurrences(anchorDate, canon.repeat, fromMs, rangeEndMs)) {
          const bucket = bucketByDate.get(occurrence.dateKey);
          if (!bucket) continue;
          bucket.entries.push({
            kind: "repeat",
            label: kind === "deadline" ? "Repeats" : "Repeats (sched)",
            todoId: todo.id,
            date: occurrence.date,
            dateKey: occurrence.dateKey,
            time: occurrence.time,
            urgency: todo.urgency ?? 0,
            virtual: true,
          });
        }
      }
    }
  }

  for (const bucket of dayBuckets) {
    bucket.entries.sort((a, b) => {
      if (a.time && b.time) return a.time.localeCompare(b.time);
      if (a.time && !b.time) return -1;
      if (!a.time && b.time) return 1;
      return b.urgency - a.urgency;
    });
  }

  const stats = { open: 0, doing: 0, done: 0, cancelled: 0, blocked: 0, overdue: 0 };
  for (const todo of todos) {
    if (todo.effectiveStatus === "blocked") stats.blocked++;
    else if (todo.status === "todo") stats.open++;
    else if (todo.status === "doing") stats.doing++;
    else if (todo.status === "done") stats.done++;
    else if (todo.status === "cancelled") stats.cancelled++;
    const ddl = todo.canon?.ddl ? parseDateValue(todo.canon.ddl) : null;
    if (ddl && ddl.time < todayMid && !CLOSED_STATUSES.has(todo.status)) stats.overdue++;
  }

  const payload = {
    type: "agenda",
    range: { from: dayBuckets[0]?.date || todayKey, to: dayBuckets[dayBuckets.length - 1]?.date || todayKey, today: todayKey },
    days: dayBuckets.map(({ date, entries }) => ({ date, entries })),
    todos: sortByUrgency(todos),
    lints,
    logByDay,
    stats,
  };
  if (includePlanning) {
    const { lints: clockLints } = resolveClockRefs(clocks, todos);
    const clockQualityLints = lintClocks(clocks);
    payload.projects = projects;
    payload.milestones = milestones;
    payload.clocks = clocks;
    payload.clocktable = buildClockModel(clocks, todos, projects);
    payload.projectModel = buildProjectModel(projects, todos, clocks);
    payload.lints = [...lints, ...clockLints, ...clockQualityLints];
  }
  if (body.includeGantt === true) {
    payload.gantt = buildGanttModel(todos, projects, milestones);
    payload.lints = [...payload.lints, ...(payload.gantt.lints || [])];
  }
  await rememberAgendaPayload(body, todayKey, payload);
  return payload;
}

// --- canonical-key patching (alias-preserving) + repeater-aware completion --

function normalizeCanonPatchValue(key, value) {
  if (value === null || value === undefined || value === false) return "";
  const raw = String(value).trim();
  if (!raw) return "";
  if (key === "prio") {
    const p = raw.toUpperCase();
    return /^[A-Z]$/.test(p) ? p : "";
  }
  if (key === "ddl" || key === "sche" || key === "end" || key === "date" || key === "done") return normalizeDateValue(raw) || raw;
  if (key === "progress") return String(Math.max(0, Math.min(100, Number(raw) || 0)));
  if (key === "repeat") return parseRepeater(raw) ? raw : "";
  return raw;
}

// Writes canonical-key values into a `@@todo` source line, reusing whichever
// alias the line already has (e.g. keeps `due:` as `due:`) and only using
// the canonical spelling when the arg is brand new.
function patchTodoSourceCanonical(source, canonPatch = {}) {
  const text = String(source || "");
  const node = scanPlanningNodes(text, { kind: "todo" })[0];
  if (!node || node.span.from !== 0) return text;
  const args = { ...(node.attrs || {}) };
  for (const [canonKey, rawValue] of Object.entries(canonPatch)) {
    const value = normalizeCanonPatchValue(canonKey, rawValue);
    if (value) {
      const argKey = todoArgKeyForCanonical(canonKey, node.attrs || {});
      args[argKey] = value;
    } else {
      for (const alias of TODO_KEY_ALIASES[canonKey] || [canonKey]) delete args[alias];
    }
  }
  return node.shape === "block"
    ? patchPlanningNodeRaw(node, { attrs: args })
    : replaceTodoArgsInSource(text, node.attrsRaw || "", serializeInlineAttrs(args));
}

function appendDepRef(existingAfter, ref) {
  const parts = String(existingAfter || "")
    .split("&")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.includes(ref)) parts.push(ref);
  return parts.join(" & ");
}

const CANON_PATCH_KEYS = ["id", "ddl", "sche", "end", "date", "prio", "repeat", "warn", "after", "blocks", "project", "area", "phase", "goal", "effort", "progress", "owner", "tags", "context", "done", "log"];
const LEGACY_PATCH_TO_CANON = { priority: "prio", due: "ddl", deadline: "ddl", scheduled: "sche", start: "sche", finish: "end", pct: "progress", proj: "project", rep: "repeat", every: "repeat", lead: "warn", dep: "after", ctx: "context" };
const CREATE_TODO_KEYS = ["ddl", "sche", "end", "prio", "repeat", "warn", "after", "blocks", "project", "area", "phase", "goal", "effort", "progress", "owner", "tags", "context"];

function planningNodeArgs(source) {
  const node = scanPlanningNodes(source, { kind: "todo" })[0];
  if (node && node.span.from === 0) return node.attrs || {};
  return scanInlineCommands(source, "todo")[0]?.args || {};
}

function argValueForCanonical(args, canonKey) {
  for (const alias of TODO_KEY_ALIASES[canonKey] || [canonKey]) {
    if (args && Object.prototype.hasOwnProperty.call(args, alias) && args[alias]) return args[alias];
  }
  return "";
}

function escapePlanningTitle(text) {
  return String(text || "").replace(/([\]\\])/g, "\\$1");
}

function defaultTodoFileTitle(file) {
  const stem = basename(file, extname(file)).replace(/[-_]+/g, " ").trim();
  return stem ? stem.replace(/\b\w/g, (ch) => ch.toUpperCase()) : "Inbox";
}

function resolveTodoCreateFile(rawInput) {
  const raw = String(rawInput || "").trim();
  const file = raw
    ? resolveInputPath(raw, noteRoot)
    : join(noteRoot, "inbox.md");
  if (!inside(file, noteRoot)) {
    const err = new Error(`Todo target is outside note root: ${file}`);
    err.statusCode = 403;
    throw err;
  }
  if (!/\.(?:md|markdown)$/i.test(file)) {
    const err = new Error("Todo target must be a Markdown file");
    err.statusCode = 400;
    throw err;
  }
  return file;
}

function lineNumberAt(text, index) {
  return String(text || "").slice(0, Math.max(0, index)).split("\n").length;
}

// Stable planning-node ids are minted on demand (org-id model), not on
// every save: `createTodo` always mints one for a brand-new todo;
// `ensureTodoId` mints one for an existing todo the first time something
// needs a durable anchor into it (the dependency picker, clock-in). Base36,
// 6 chars, checked against every id already in the vault so a fresh mint
// never collides.
function randomIdSegment() {
  return Math.random().toString(36).slice(2, 8).padEnd(6, "0");
}

// Ids minted between vault scans (concurrent clock-ins / dep-picks) so a
// second mint in the same window never returns a candidate the first mint
// already claimed but hasn't written to disk yet. Drained lazily: once a
// reserved id is observed in a freshly-scanned `existing` set, it's removed
// (it's now covered by the scan itself and would otherwise never be freed).
const reservedPlanningIds = new Set();

// The existing-id set is expensive to rebuild (a full vault planning scan)
// and doesn't change between vault-index versions, so it's cached per
// `notesIndexVersionValue()` — a mint immediately after another mint (no
// intervening dirty mark) reuses the same set instead of rescanning.
let planningIdCache = { version: -1, ids: null };

async function existingPlanningIds() {
  const version = notesIndexVersionValue();
  if (planningIdCache.version === version && planningIdCache.ids) {
    return planningIdCache.ids;
  }
  const planning = await scanPlanningItems();
  const existing = new Set();
  for (const group of [planning.todos, planning.projects, planning.milestones, planning.clocks]) {
    for (const item of group) {
      if (typeof item.id === "string" && item.id.startsWith("#")) existing.add(item.id.slice(1));
    }
  }
  planningIdCache = { version, ids: existing };
  return existing;
}

async function generatePlanningId() {
  const existing = await existingPlanningIds();
  const unavailable = new Set(existing);
  for (const id of reservedPlanningIds) {
    if (existing.has(id)) reservedPlanningIds.delete(id);
    else unavailable.add(id);
  }
  let candidate = randomIdSegment();
  let guard = 0;
  while (unavailable.has(candidate)) {
    guard++;
    candidate = guard < 50 ? randomIdSegment() : fallbackPlanningIdSegment(guard);
    if (guard > 500) {
      const err = new Error("Could not mint a unique planning id");
      err.statusCode = 500;
      throw err;
    }
  }
  reservedPlanningIds.add(candidate);
  return candidate;
}

let planningIdFallbackCounter = 0;
function fallbackPlanningIdSegment(guard = 0) {
  planningIdFallbackCounter = (planningIdFallbackCounter + 1) % 36 ** 3;
  return `${Date.now().toString(36)}${guard.toString(36)}${planningIdFallbackCounter.toString(36)}`
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase()
    .slice(-6)
    .padStart(6, "0");
}

function todoSourceFromCreateBody(body = {}, id = "") {
  const text = String(body.text || body.title || "").trim();
  if (!text) {
    const err = new Error("Todo text is required");
    err.statusCode = 400;
    throw err;
  }
  const status = normalizeTodoStatus(body.status || "todo");
  const attrs = {};
  if (id) attrs.id = id;
  for (const key of CREATE_TODO_KEYS) {
    if (bodyHasOwn(body, key)) {
      const value = normalizeCanonPatchValue(key, body[key]);
      if (value) attrs[key] = value;
    }
  }
  for (const [legacy, canon] of Object.entries(LEGACY_PATCH_TO_CANON)) {
    if (!CREATE_TODO_KEYS.includes(canon)) continue;
    if (bodyHasOwn(body, legacy) && !bodyHasOwn(attrs, canon)) {
      const value = normalizeCanonPatchValue(canon, body[legacy]);
      if (value) attrs[canon] = value;
    }
  }
  const args = serializeInlineAttrs(attrs);
  const statusPart = status === "todo" ? "" : `(${status})`;
  return `@@todo${statusPart} [${escapePlanningTitle(text)}]${args ? ` ${args}` : ""}`;
}

function initialTodoFileContent(file) {
  const title = defaultTodoFileTitle(file);
  return [
    buildMetaBlock({
      id: `${timestampId()}-${slugifyTitle(title)}`,
      title,
      date: new Date().toISOString().slice(0, 10),
      kind: defaultNoteKind,
      tags: [],
      refs: [],
    }),
    `# ${title}`,
    "",
  ].join("\n");
}

export async function createTodo(body = {}) {
  const file = resolveTodoCreateFile(body.file || body.path || "");
  const id = await generatePlanningId();
  const source = todoSourceFromCreateBody(body, id);
  return enqueueSaveWrite(file, async () => {
    await mkdir(dirname(file), { recursive: true });
    const existed = existsSync(file);
    let content = existed ? await readFile(file, "utf8") : initialTodoFileContent(file);
    const base = content.replace(/\s*$/, "");
    const prefix = base ? "\n\n" : "";
    const nextContent = `${base}${prefix}${source}\n`;
    const index = base.length + prefix.length;
    await atomicWriteFile(file, nextContent, "utf8");
    markNotesDirty(file);
    scheduleRoamDbSync(null, file);
    let mtimeMs = 0;
    try { mtimeMs = (await stat(file)).mtimeMs; } catch {}
    const meta = noteMetadata(nextContent);
    const noteTitle = String(meta.title || defaultTodoFileTitle(file));
    const todos = extractTodos(nextContent, {
      file,
      path: displayPathForFile(file),
      key: noteTitle,
      id: String(meta.id || ""),
      title: noteTitle,
      project: String(meta.project || meta.proj || "").trim(),
    }, mtimeMs);
    const created = todos.find((todo) => todo.index === index) || null;
    return {
      type: "todo-created",
      ok: true,
      file,
      path: displayPathForFile(file),
      createdFile: !existed,
      changed: true,
      index,
      line: lineNumberAt(nextContent, index),
      source,
      todo: created,
      mtimeMs,
    };
  });
}

// General todo patch: writes any canonical key (or its legacy alias field
// name) plus `status`, straight back into the source `@@todo` line. `op:
// "complete"` runs the repeater engine — rolling `ddl`/`sche` forward,
// resetting status to `todo`, and recording `done`/`log` — instead of a
// plain status flip.
async function patchTodoInFile(file, body) {
  const content = await readFile(file, "utf8");
  const loc = locateTodoInContent(content, body, file);
  if (!loc) {
    const err = new Error("Todo source was not found");
    err.statusCode = 404;
    throw err;
  }
  const { from, to } = loc;
  const oldSource = content.slice(from, to);
  const op = body.op === "complete" ? "complete" : "patch";
  const nowMs = Date.now();

  const canonPatch = {};
  for (const key of CANON_PATCH_KEYS) {
    if (bodyHasOwn(body, key)) canonPatch[key] = body[key];
  }
  for (const [legacy, canon] of Object.entries(LEGACY_PATCH_TO_CANON)) {
    if (bodyHasOwn(body, legacy) && !bodyHasOwn(canonPatch, canon)) canonPatch[canon] = body[legacy];
  }
  const args0 = planningNodeArgs(oldSource);
  if (bodyHasOwn(body, "afterAdd")) {
    canonPatch.after = appendDepRef(argValueForCanonical(args0, "after"), String(body.afterAdd));
  }

  let statusPatch = "";
  if (op === "complete") {
    const repeaterRaw = argValueForCanonical(args0, "repeat");
    const repeater = parseRepeater(repeaterRaw);
    const doneStr = formatDateValue(nowMs, false);
    if (repeater) {
      const ddlVal = argValueForCanonical(args0, "ddl");
      const scheVal = argValueForCanonical(args0, "sche");
      if (ddlVal) canonPatch.ddl = applyRepeater(ddlVal, repeater, nowMs);
      if (scheVal) canonPatch.sche = applyRepeater(scheVal, repeater, nowMs);
      canonPatch.done = doneStr;
      const logParts = String(argValueForCanonical(args0, "log")).split("&").map((s) => s.trim()).filter(Boolean);
      logParts.push(doneStr);
      while (logParts.length > 30) logParts.shift();
      canonPatch.log = logParts.join(" & ");
      statusPatch = "todo";
    } else {
      canonPatch.done = doneStr;
      statusPatch = "done";
    }
  } else if (bodyHasOwn(body, "status")) {
    statusPatch = normalizeTodoStatus(body.status);
  }

  let next = oldSource;
  if (statusPatch) next = replaceTodoStatusInSource(next, statusPatch);
  if (Object.keys(canonPatch).length > 0) next = patchTodoSourceCanonical(next, canonPatch);

  if (next === oldSource) {
    let mtimeMs = 0;
    try { mtimeMs = (await stat(file)).mtimeMs; } catch {}
    return { type: "todo-patched", ok: true, file, changed: false, from, to, source: oldSource, mtimeMs };
  }

  await atomicWriteFile(file, content.slice(0, from) + next + content.slice(to), "utf8");
  markNotesDirty(file);
  scheduleRoamDbSync(null, file);
  let mtimeMs = 0;
  try { mtimeMs = (await stat(file)).mtimeMs; } catch {}
  return { type: "todo-patched", ok: true, file, changed: true, from, to, source: oldSource, nextSource: next, mtimeMs };
}

// Serialized against editor saves and every other agenda mutation on the
// same file via enqueueSaveWrite — the whole read/locate/write cycle runs
// inside the queue so a concurrent editor save can never interleave with it.
export async function patchTodo(body = {}) {
  const file = safeOpenFile(body.file || "");
  return enqueueSaveWrite(file, () => patchTodoInFile(file, body));
}

export async function completeTodo(body = {}) {
  return patchTodo({ ...body, op: "complete" });
}

// Mints and writes a stable `id:` for the todo located by `body` (same
// locator fields as patchTodo) the first time something needs a durable
// anchor into it — a todo that's never been referenced stays id-less
// forever. Idempotent: a todo that already has an id is returned unchanged
// (`changed: false`). Reuses patchTodoInFile's locate/write/dirty/sync
// pipeline directly (not the queued `patchTodo` export) — calling the queued
// wrapper here would deadlock, since this function itself already runs
// inside this file's queue.
async function ensureTodoIdInFile(file, body) {
  const content = await readFile(file, "utf8");
  const loc = locateTodoInContent(content, body, file);
  if (!loc) {
    const err = new Error("Todo source was not found");
    err.statusCode = 404;
    throw err;
  }
  const { from, to } = loc;
  const oldSource = content.slice(from, to);
  const existingId = planningNodeArgs(oldSource).id;
  if (existingId) {
    let mtimeMs = 0;
    try { mtimeMs = (await stat(file)).mtimeMs; } catch {}
    return { type: "todo-id", ok: true, file, id: `#${existingId}`, changed: false, from, to, source: oldSource, mtimeMs };
  }
  const id = await generatePlanningId();
  const result = await patchTodoInFile(file, { ...body, file, id });
  return { ...result, type: "todo-id", id: `#${id}` };
}

export async function ensureTodoId(body = {}) {
  const file = safeOpenFile(body.file || "");
  return enqueueSaveWrite(file, () => ensureTodoIdInFile(file, body));
}

// --- clock-in / clock-out -----------------------------------------------

function escapeBracketTitle(text) {
  return String(text || "").replace(/([\]\\])/g, "\\$1");
}

// Finds the clock node to close: an explicit index+source match (the exact
// clock the caller means), else the first open clock (`from` set, no `to`)
// in this file's content.
function findClockNode(content, locator = {}) {
  const nodes = scanPlanningNodes(content, { kind: "clock" });
  const { index, source } = locator;
  if (typeof index === "number" && source) {
    const exact = nodes.find((n) => n.span.from === index && n.raw === source);
    if (exact) return exact;
  }
  return nodes.find((n) => n.attrs?.from && !n.attrs?.to) || null;
}

async function closeClockInFileUnlocked(file, locator, toIso) {
  const content = await readFile(file, "utf8");
  const node = findClockNode(content, locator);
  if (!node) return false;
  const patched = patchPlanningNodeRaw(node, { attrs: { to: toIso } });
  if (patched === node.raw) return false;
  await atomicWriteFile(file, content.slice(0, node.span.from) + patched + content.slice(node.span.to), "utf8");
  markNotesDirty(file);
  scheduleRoamDbSync(null, file);
  return true;
}

async function closeClockInFile(file, locator, toIso) {
  return enqueueSaveWrite(file, () => closeClockInFileUnlocked(file, locator, toIso));
}

async function enqueueClockMutation(task) {
  const previous = clockMutationQueue;
  const current = previous.catch(() => {}).then(task);
  clockMutationQueue = current;
  try {
    return await current;
  } finally {
    if (clockMutationQueue === current) clockMutationQueue = Promise.resolve();
  }
}

// Finds the single globally-running clock (a `from` with no `to`) across
// the whole vault, if any.
async function findRunningClock() {
  const planning = await scanPlanningItems();
  return planning.clocks.find((c) => c.args?.from && !c.args?.to) || null;
}

// Starts a clock on the todo located by `body` (same locator fields as
// patchTodo: index+source, or id/text fallback), inserting a new
// `@@clock [task]{from: now, task: "#id"}` line right after the todo's
// line/block. The todo is minted a stable id first (if it doesn't have one)
// so the clock's anchor survives the todo's title being edited later — the
// bracket title stays human-readable text, `task:` is the durable link (see
// `resolveClockRefs`). Only one clock may run at a time vault-wide, so any
// currently-running clock is auto-closed first — mirroring org's clock-in.
async function clockInUnlocked(body = {}) {
  const file = safeOpenFile(body.file || "");
  const nowIso = formatDateValue(Date.now(), true);

  // Step 1: close any running clock first, fully awaited (queued and
  // serialized on its own file) before touching `file` below — if the
  // running clock happens to live in `file` itself, this ordering (rather
  // than nesting) is what keeps the two writes from deadlocking on the same
  // per-file queue.
  const running = await findRunningClock();
  if (running) await closeClockInFile(running.file, { index: running.index, source: running.source }, nowIso);

  // Step 2: id-mint and clock-line insert happen inside a *single* queued
  // task on `file`, so no concurrent editor save can land between the
  // id-mint write and the insert write (both operate on freshly re-read
  // content). `ensureTodoIdInFile` may itself rewrite the todo's line
  // (adding `id=...`), so its own `from`/`to` — not a fresh
  // `locateTodoInContent(body)` — are the authoritative position afterward:
  // re-locating with the now-stale pre-mutation `body.source` could fail to
  // text-match the changed line.
  return enqueueSaveWrite(file, async () => {
    const idResult = await ensureTodoIdInFile(file, body);
    const from = idResult.from;
    const to = idResult.changed ? idResult.from + idResult.nextSource.length : idResult.to;

    const content = await readFile(file, "utf8");
    const todoNode = scanPlanningNodes(content.slice(from, to), { kind: "todo" })[0];
    const title = escapeBracketTitle(todoNode?.title || "");

    const lineEnd = content.indexOf("\n", to);
    const insertAt = lineEnd < 0 ? content.length : lineEnd + 1;
    const needsLeadingNewline = lineEnd < 0 && content.length > 0 && !content.endsWith("\n");
    const clockLine = `${needsLeadingNewline ? "\n" : ""}@@clock [${title}]{from: ${nowIso}, task: ${idResult.id}}\n`;

    await atomicWriteFile(file, content.slice(0, insertAt) + clockLine + content.slice(insertAt), "utf8");
    markNotesDirty(file);
    scheduleRoamDbSync(null, file);
    return { type: "clock-in", ok: true, file, from: insertAt, to: insertAt + clockLine.length, source: clockLine, todoId: idResult.id };
  });
}

export async function clockIn(body = {}) {
  return enqueueClockMutation(() => clockInUnlocked(body));
}

// Stops a clock: closes the clock named by `body.file`+index/source if
// given, else whichever clock is running vault-wide.
async function clockOutUnlocked(body = {}) {
  const nowIso = formatDateValue(Date.now(), true);

  if (body.file) {
    const file = safeOpenFile(body.file);
    const closed = await closeClockInFile(file, { index: body.index, source: body.source }, nowIso);
    if (closed) return { type: "clock-out", ok: true, file, to: nowIso };
  }

  const running = await findRunningClock();
  if (!running) {
    const err = new Error("No running clock");
    err.statusCode = 404;
    throw err;
  }
  const file = safeOpenFile(running.file);
  await closeClockInFile(file, { index: running.index, source: running.source }, nowIso);
  return { type: "clock-out", ok: true, file, to: nowIso };
}

export async function clockOut(body = {}) {
  return enqueueClockMutation(() => clockOutUnlocked(body));
}

// Generates the shortest word-boundary-unique text reference to `target`
// (for writing into another todo's `after` arg), prefixed with
// `[[Note Title]]::` when the reference crosses files.
export function depRefForTodo(target, scopeTodos, sourceTodo) {
  const targetText = String(target?.text || "").trim();
  const words = targetText.split(/\s+/).filter(Boolean);
  const others = (scopeTodos || []).filter((t) => t.id !== target.id && t.file === target.file);
  let candidate = "";
  for (let i = 1; i <= words.length; i++) {
    const attempt = words.slice(0, i).join(" ");
    const clash = others.some((t) => String(t.text || "").trim().toLowerCase().startsWith(attempt.toLowerCase()));
    if (!clash) {
      candidate = attempt;
      break;
    }
  }
  if (!candidate) candidate = targetText;
  candidate = candidate.replace(/&/g, "").replace(/"/g, "").trim();
  const crossFile = !sourceTodo || sourceTodo.file !== target.file;
  const refBody = crossFile ? `[[${target.noteTitle}]]::${candidate}` : candidate;
  return /[,&]/.test(refBody) ? `"${refBody}"` : refBody;
}

// Completion candidates for `after:`/`blocks:`/clock `task:` values. Same-
// file todos rank first (they're the common case and never need a
// `[[Note]]::` prefix), then open statuses before closed ones. Candidates
// that already have a stable id insert `#id` (durable); everything else
// falls back to the same shortest-unique text ref `depRefForTodo` writes
// for the explicit dependency picker — passive completion never mints an
// id, only an explicit action (the picker, clock-in) does.
export async function todoRefCompletions(body = {}) {
  const prefix = String(body.prefix || "").trim().toLowerCase();
  const file = body.file ? safeOpenFile(body.file) : "";
  const excludeId = String(body.excludeId || "");
  const limit = Math.max(1, Math.min(50, Number(body.limit) || 20));
  const statusRank = { blocked: 0, doing: 1, todo: 2, done: 3, cancelled: 4 };
  const todos = (await scanTodos()).filter((t) => t.id !== excludeId);
  const matches = prefix
    ? todos.filter((t) => t.text.toLowerCase().includes(prefix) || String(t.noteTitle || "").toLowerCase().includes(prefix))
    : todos;
  const sorted = [...matches].sort((a, b) => {
    const aSame = file && a.file === file ? 0 : 1;
    const bSame = file && b.file === file ? 0 : 1;
    if (aSame !== bSame) return aSame - bSame;
    return (statusRank[a.status] ?? 9) - (statusRank[b.status] ?? 9);
  });
  const items = sorted.slice(0, limit).map((todo) => {
    const hasId = typeof todo.id === "string" && todo.id.startsWith("#");
    const scope = todos.filter((t) => t.file === todo.file);
    const ref = hasId ? todo.id : depRefForTodo(todo, scope, file ? { file } : null);
    return {
      label: `${String(todo.status || "todo").toUpperCase()} · ${todo.text} · ${todo.noteTitle || ""}`,
      ref,
      hasId,
      file: todo.file,
      status: todo.status,
    };
  });
  return { type: "todo-ref-completions", items };
}

function existingUniqueDirs(dirs) {
  const out = [];
  const seen = new Set();
  for (const dir of dirs) {
    const resolved = resolve(dir);
    if (seen.has(resolved) || !existsSync(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

function snippetDirs() {
  const raw = process.env.AARONNOTE_SNIPPETS;
  if (raw) return existingUniqueDirs(raw.split(delimiter).filter(Boolean));
  return existingUniqueDirs([
    process.env.AARONNOTE_EMACS_SNIPPETS_ROOT || join(homedir(), ".config", "emacs", "snippets"),
    snippetsRoot,
  ]);
}

async function snippetRoots() {
  const roots = snippetDirs().map((dir) => ({ dir, kind: "" }));
  const kindRoots = [
    resolve(workspaceRoot, "kinds"),
    resolve(appDir, "..", "kinds"),
    resolve(process.cwd(), "kinds"),
  ].filter((dir, index, dirs) => dirs.indexOf(dir) === index && existsSync(dir));
  for (const kindsRoot of kindRoots) {
    try {
      const entries = await readdir(kindsRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const kind = normalizeNoteKind(entry.name);
        if (kind === defaultNoteKind || kind !== entry.name.toLowerCase()) continue;
        const dir = resolve(kindsRoot, entry.name, "snippet");
        if (existsSync(dir) && !roots.some((root) => root.dir === dir)) roots.push({ dir, kind });
      }
    } catch {}
  }
  return roots;
}

export function parseSnippetBody(content) {
  const lines = content.split(/\r?\n/);
  const headers = new Map();
  let bodyStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const marker = lines[i].match(/^# --\s*$/);
    if (marker) {
      bodyStart = i + 1;
      while (bodyStart < lines.length && /^# --\s*$/.test(lines[bodyStart])) bodyStart++;
      break;
    }
    const header = lines[i].match(/^#\s*([^:\n]+):\s*(.*)$/);
    if (header) headers.set(header[1].trim().toLowerCase(), header[2].trim());
  }
  const bodyLines = lines.slice(bodyStart);
  // Files conventionally end in one newline. Drop only that transport newline;
  // trailing spaces and intentional blank lines are snippet content.
  if (bodyLines.at(-1) === "") bodyLines.pop();
  return { headers, body: bodyLines.join("\n") };
}

function snippetHeaderList(value) {
  const source = String(value || "").trim();
  if (!source) return [];
  if (source.startsWith("[")) {
    try {
      const parsed = JSON.parse(source);
      if (Array.isArray(parsed)) return parsed.map(String).map((item) => item.trim()).filter(Boolean);
    } catch {}
  }
  return source.split(/\s*,\s*|\s+/).map((item) => item.trim()).filter(Boolean);
}

function snippetContributorMetadata(headers) {
  const source = String(headers.get("contributor") || "");
  // "Aaronnote" remains accepted for existing shared YAS catalogs.
  const match = /^(?:Noema|Aaronnote)\s+(.+)$/.exec(source);
  if (!match) return {};
  try {
    return Object.fromEntries(new URLSearchParams(match[1]));
  } catch {
    return {};
  }
}

function snippetBrowserCompatibility(body) {
  const safeSelected = /`\(or\s+yas-selected-text\s+(?:"[^"]*"|'[^']*'|nil)\)`/g;
  const safeChoice = /\$\{\d+:\$\$\(yas-choose-value\s+'\([^)]*\)\)\}/g;
  const stripped = String(body || "").replace(safeSelected, "").replace(safeChoice, "");
  const dynamicBacktick = [...stripped.matchAll(/`([^`]*)`/g)]
    .some((match) => !/\$(?:\d+|\{\d+(?::[^}]*)?\})/.test(match[1] || ""));
  if (dynamicBacktick || /\$\$?\([^)]*\)/.test(stripped)) {
    return { browserCompatible: false, diagnostic: "dynamic Emacs Lisp is not executed in Noema" };
  }
  if (/\$\{(?:TM_[A-Z_]+|[A-Z][A-Z0-9_]+)(?::[^}]*)?\}/.test(stripped)) {
    return { browserCompatible: false, diagnostic: "unsupported TextMate variable" };
  }
  return { browserCompatible: true };
}

function snippetProvider(headers, metadata, file, rootIndex) {
  const declared = String(headers.get("provider") || metadata.provider || "").trim().toLowerCase();
  if (declared) return declared;
  const normalized = file.split(sep).join("/");
  if (normalized.includes("/generated/latex-workshop/")) return "latex-workshop";
  if (normalized.includes("/generated/overleaf/")) return "overleaf";
  return rootIndex === 0 ? "personal" : "aaronnote";
}

function snippetDefaultPriority(provider) {
  return ({ personal: 500, document: 440, katex: 400, aaronnote: 300, "latex-workshop": 180, overleaf: 160 })[provider] || 240;
}

export async function scanSnippets(options = {}) {
  const roots = await snippetRoots();
  const key = roots.map((root) => `${root.kind}@${root.dir}`).join(":");
  const now = Date.now();
  if (!options.force && snippetCache.key === key && now - snippetCache.scannedAt < 10_000) {
    return snippetCache.snippets;
  }
  const byIdentity = new Map();
  for (let rootIndex = 0; rootIndex < roots.length; rootIndex++) {
    const root = roots[rootIndex];
    const files = (await walkFiles(root.dir, (_file, name) => !name.startsWith(".") && !name.endsWith(".el")))
      .sort((a, b) => relative(root.dir, a).localeCompare(relative(root.dir, b)));
    const parsed = await mapLimit(files, scanConcurrency, async (file) => {
      try {
        const content = await readFile(file, "utf8");
        const { headers, body } = parseSnippetBody(content);
        if (!body.trim()) return null;
        const rel = relative(root.dir, file);
        const parts = rel.split(sep);
        const mode = parts[0] || "";
        const key = headers.get("key") || parts.at(-1) || "snippet";
        const metadata = snippetContributorMetadata(headers);
        const provider = snippetProvider(headers, metadata, file, rootIndex);
        const priorityHeader = Number(headers.get("priority") ?? metadata.priority);
        const weightHeader = Number(headers.get("weight") ?? metadata.weight);
        const context = String(headers.get("context") || metadata.context || "").trim().toLowerCase();
        const compatibility = snippetBrowserCompatibility(body);
        return {
          id: headers.get("id") || headers.get("uuid") || `${provider}:${root.kind}:${mode}:${key}`,
          key,
          aliases: snippetHeaderList(headers.get("aliases") || headers.get("prefixes") || metadata.aliases),
          name: headers.get("name") || key,
          description: headers.get("description") || metadata.description || "",
          mode,
          group: headers.get("group") || "",
          kind: root.kind,
          body,
          source: file,
          provider,
          priority: Number.isFinite(priorityHeader) ? priorityHeader : snippetDefaultPriority(provider),
          weight: Number.isFinite(weightHeader) ? weightHeader : 0,
          context: ["prose", "org-meta", "markdown", "math", "math-command", "math-at"].includes(context) ? context : undefined,
          ...compatibility,
        };
      } catch {
        return null;
      }
    });
    for (const snippet of parsed) {
      if (!snippet) continue;
      const id = `${snippet.kind}\0${snippet.mode}\0${snippet.key}`;
      const previous = byIdentity.get(id);
      if (!previous) {
        byIdentity.set(id, snippet);
        continue;
      }
      const snippetWins = snippet.priority > previous.priority
        || (snippet.priority === previous.priority && snippet.source.localeCompare(previous.source) < 0);
      const winner = snippetWins ? snippet : previous;
      const other = snippetWins ? previous : snippet;
      byIdentity.set(id, {
        ...winner,
        aliases: [...new Set([...(winner.aliases || []), ...(other.aliases || [])])],
        // Upstream frequency is useful even when a personal expansion wins.
        weight: Math.max(Number(winner.weight) || 0, Number(other.weight) || 0),
      });
    }
  }
  const snippets = [...byIdentity.values()];
  snippetCache = {
    key,
    scannedAt: now,
    snippets: snippets.sort((a, b) => `${a.kind}/${a.mode}/${a.key}`.localeCompare(`${b.kind}/${b.mode}/${b.key}`)),
  };
  return snippetCache.snippets;
}

function templateDirs() {
  const raw = process.env.AARONNOTE_TEMPLATES;
  if (raw) return existingUniqueDirs(raw.split(delimiter).filter(Boolean));
  return existingUniqueDirs([templatesRoot]);
}

function templateIdentity(rootDir, file, headers) {
  const rel = relative(rootDir, file);
  const parts = rel.split(sep).filter(Boolean);
  const fileKey = headers.get("key") || parts.at(-1) || "template";
  let kind = headers.get("kind") ? normalizeNoteKind(headers.get("kind")) : "";
  let mode = headers.get("mode") || "markdown-mode";
  if (parts[0] === "markdown-mode") {
    mode = parts[0];
  } else if (parts[0]) {
    const folderKind = normalizeNoteKind(parts[0]);
    if (folderKind !== defaultNoteKind && folderKind === parts[0].toLowerCase()) kind = folderKind;
    if (parts[1] === "markdown-mode") mode = parts[1];
  }
  const key = kind ? `${kind}/${fileKey}` : fileKey;
  return { key, name: headers.get("name") || fileKey, mode, kind };
}

export async function scanTemplates(options = {}) {
  const roots = templateDirs();
  const key = roots.join(":");
  const now = Date.now();
  if (!options.force && templateCache.key === key && now - templateCache.scannedAt < 10_000) {
    return templateCache.templates;
  }
  const templates = [];
  for (const rootDir of roots) {
    const files = await walkFiles(rootDir, (_file, name) => !name.startsWith(".") && !name.endsWith(".el"));
    for (const file of files) {
      try {
        const content = await readFile(file, "utf8");
        const { headers, body } = parseSnippetBody(content);
        if (!body.trim()) continue;
        const identity = templateIdentity(rootDir, file, headers);
        templates.push({
          ...identity,
          group: headers.get("group") || "templates",
          body,
          source: file,
        });
      } catch {}
    }
  }
  templateCache = {
    key,
    scannedAt: now,
    templates: templates.sort((a, b) => `${a.kind}/${a.key}`.localeCompare(`${b.kind}/${b.key}`)),
  };
  return templateCache.templates;
}

function templateVarsForNode({ title, id, tags, kind, path }) {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const time = now.toTimeString().slice(0, 5);
  const folder = groupKeyFor(resolveInputPath(path, noteScanRoot), noteScanRoot);
  return {
    title,
    slug: slugifyTitle(title),
    date,
    time,
    id,
    path: slashPath(path),
    folder: folder === "Root" ? "" : folder,
    kind,
    tags: normalizeTags(tags).join(", "),
  };
}

function replaceTemplateVariables(body, vars) {
  return String(body || "").replace(/\{\{\s*([A-Za-z][\w-]*)\s*\}\}/g, (_m, key) => {
    return Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key] ?? "") : "";
  });
}

function expandTemplateBody(body, vars) {
  const source = replaceTemplateVariables(body, vars);
  const values = new Map();
  let text = "";
  let cursor = null;
  let i = 0;

  function valueFor(index, fallback) {
    if (!values.has(index)) values.set(index, fallback);
    return values.get(index) ?? "";
  }

  function pushTabstop(index, value) {
    const from = text.length;
    text += value;
    const to = text.length;
    if (cursor == null || index === 0) cursor = { from: index === 0 ? to : from, to };
  }

  while (i < source.length) {
    const rest = source.slice(i);
    const choice = rest.match(/^\$\{(\d+)\|([^}]*)\|\}/);
    if (choice) {
      const index = Number(choice[1]);
      const options = choice[2].split(",").map((x) => x.trim()).filter(Boolean);
      pushTabstop(index, valueFor(index, options[0] ?? ""));
      i += choice[0].length;
      continue;
    }
    const placeholder = rest.match(/^\$\{(\d+):([^}]*)\}/);
    if (placeholder) {
      const index = Number(placeholder[1]);
      pushTabstop(index, valueFor(index, placeholder[2]));
      i += placeholder[0].length;
      continue;
    }
    const braced = rest.match(/^\$\{(\d+)\}/);
    if (braced) {
      const index = Number(braced[1]);
      pushTabstop(index, valueFor(index, ""));
      i += braced[0].length;
      continue;
    }
    const plain = rest.match(/^\$(\d+)/);
    if (plain) {
      const index = Number(plain[1]);
      pushTabstop(index, index === 0 ? "" : valueFor(index, ""));
      i += plain[0].length;
      continue;
    }
    text += source[i];
    i++;
  }
  return { text, selection: cursor };
}

async function templateByKey(key) {
  const wanted = String(key || "").trim();
  if (!wanted) return null;
  const templates = await scanTemplates();
  return templates.find((template) => template.key === wanted)
    ?? templates.find((template) => template.key.split("/").at(-1) === wanted)
    ?? null;
}

function latexExportStateFile() {
  return join(stateRoot, "export-latex.json");
}

async function readLatexExportState() {
  try {
    const raw = await readFile(latexExportStateFile(), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writeLatexExportState(state) {
  await atomicWriteFile(latexExportStateFile(), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

let latexExportStateQueue = Promise.resolve();
function updateLatexExportState(mutator) {
  const update = latexExportStateQueue.then(async () => {
    const state = await readLatexExportState();
    const next = await mutator(state && typeof state === "object" ? state : {});
    await writeLatexExportState(next);
    return next;
  });
  latexExportStateQueue = update.catch(() => {});
  return update;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error("LaTeX export canceled");
  error.name = "AbortError";
  throw error;
}

function normalizeLatexExportAgent(value) {
  const agent = String(value || "").trim().toLowerCase();
  return LATEX_EXPORT_AGENTS.includes(agent) ? agent : "";
}

function normalizeLatexExportEngine(value) {
  const engine = String(value || "").trim().toLowerCase();
  return LATEX_EXPORT_ENGINES.includes(engine) ? engine : "";
}

function latexExportAgentBin(agent) {
  switch (normalizeLatexExportAgent(agent) || "codex") {
    case "claude": return latexClaudeBin;
    case "opencode": return latexOpencodeBin;
    case "codex":
    default: return latexCodexBin;
  }
}

async function applyLatexExportSettingsFromState(existingState = null) {
  const state = existingState || await readLatexExportState();
  const settings = state.settings && typeof state.settings === "object" ? state.settings : {};
  const agent = normalizeLatexExportAgent(settings.latexExportAgent || settings.agent);
  const engine = normalizeLatexExportEngine(settings.latexExportEngine || settings.engine);
  if (agent) latexExportAgent = agent;
  if (engine) latexExportEngine = engine;
  return state;
}

function latexExportAgentStatusPayload() {
  const agent = normalizeLatexExportAgent(latexExportAgent) || "codex";
  const engine = normalizeLatexExportEngine(latexExportEngine) || "codex";
  return {
    type: "latex-export-agent",
    ok: true,
    agent,
    engine,
    agents: LATEX_EXPORT_AGENTS.map((id) => {
      const bin = executablePath(latexExportAgentBin(id));
      return {
        id,
        label: id === "codex" ? "Codex" : id === "claude" ? "Claude" : "OpenCode",
        current: id === agent,
        available: agentAvailable(bin),
      };
    }),
  };
}

function resolveLatexOutputPath(input, sourceFile = "") {
  const raw = String(input || "").trim();
  if (!raw) return "";
  if (/^~(?:$|[\\/])/.test(raw) || raw.startsWith("/")) return resolveUserPath(raw);
  return resolve(sourceFile ? dirname(sourceFile) : workspaceRoot, raw);
}

function latexExportSourceFile(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  return safeOpenFile(raw);
}

function latexSafeCitationKey(value) {
  const raw = String(value || "");
  const clean = raw.replace(/[^A-Za-z0-9:_-]/g, "_").replace(/^_+|_+$/g, "").slice(-48) || "cite";
  // Sanitisation alone is not injective ("A/B" and "A?B" both become
  // "A_B"). Keep a stable digest in every generated key so distinct source
  // identifiers cannot alias the same \bibitem.
  const digest = createHash("sha256").update(raw).digest("hex").slice(0, 12);
  return `an_${clean}_${digest}`;
}

function latexCitationMaps(bibModel) {
  const byId = {};
  const byNamespaceKey = {};
  const shortCounts = new Map();
  const entries = [...new Map([
    ...(bibModel.entries || []),
    ...(bibModel.references || []).map((reference) => reference?.entry).filter(Boolean),
  ].map((entry) => [String(entry?.id || ""), entry])).values()].filter((entry) => entry?.id);
  for (const entry of entries) {
    const id = String(entry.id || "");
    if (!id) continue;
    byId[id] = latexSafeCitationKey(id);
    byNamespaceKey[`${entry.namespace}\0${entry.key}`] = byId[id];
    const short = `${entry.shortNamespace}\0${entry.key}`;
    shortCounts.set(short, (shortCounts.get(short) || 0) + 1);
  }
  for (const entry of entries) {
    const id = String(entry.id || "");
    const short = `${entry.shortNamespace}\0${entry.key}`;
    if (id && byId[id] && shortCounts.get(short) === 1) byNamespaceKey[short] = byId[id];
  }
  // The resolver is authoritative for the namespace spelling the author used.
  // Populate that exact lookup from per-item resolution so ambiguous short
  // namespaces can never be guessed by this later formatting stage.
  for (const citation of bibModel.citations || []) {
    const namespace = String(citation?.namespace || "").trim();
    for (const item of citation?.items || []) {
      const id = String(item?.id || item?.itemId || "");
      const key = String(item?.key || "").trim();
      if (namespace && key && byId[id] && (!item.status || item.status === "resolved")) {
        byNamespaceKey[`${namespace}\0${key}`] = byId[id];
      }
    }
  }
  return { byId, byNamespaceKey };
}

function bibliographyExportIssues(model) {
  const issues = [];
  const push = (value, prefix = "") => {
    const message = typeof value === "string" ? value : String(value?.message || "").trim();
    if (message) issues.push(prefix ? `${prefix}: ${message}` : message);
  };
  if (model?.ok === false) push(model.message || "bibliography resolution failed");
  for (const diagnostic of model?.diagnostics || []) push(diagnostic, "Bibliography");
  for (const citation of model?.citations || []) {
    const namespace = String(citation?.namespace || "").trim();
    const keys = Array.isArray(citation?.keys) ? citation.keys.join(";") : "";
    const label = `${namespace}${namespace && keys ? ":" : ""}${keys}` || "(?)";
    for (const diagnostic of citation?.diagnostics || []) push(diagnostic, `Citation ${label}`);
    for (const item of citation?.items || []) {
      const itemLabel = `${namespace}${namespace && item?.key ? ":" : ""}${String(item?.key || "?")}`;
      for (const diagnostic of item?.diagnostics || []) push(diagnostic, `Citation ${itemLabel}`);
      if (item?.status && item.status !== "resolved" && (!item.diagnostics || item.diagnostics.length === 0)) {
        push(`item is ${item.status}`, `Citation ${itemLabel}`);
      }
    }
  }
  return [...new Set(issues)];
}

function latexExportTitle(sourceFile, bodyTitle, metaTitle = "") {
  const title = String(metaTitle || bodyTitle || "").trim();
  if (title) return title;
  if (sourceFile) {
    const fileTitle = basename(sourceFile).replace(/\.[^.]+$/, "").trim();
    if (fileTitle) return fileTitle;
  }
  return "Noema";
}

function latexSourceNameTitle(sourceFile, bodyTitle = "") {
  const raw = String(bodyTitle || (sourceFile ? basename(sourceFile).replace(/\.[^.]+$/, "") : "")).trim();
  return raw
    .replace(/^\d{8}T\d{6}[-_ ]*/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function meaningfulSourceTitle(title) {
  const value = String(title || "").trim();
  if (!value || value.length < 3) return false;
  return !/^(?:untitled|new note|note|document|export|aaronnote|assg|assign|hw\d*|q\d+|question\s*\d*|draft|tmp|test|\d{8,}|[0-9a-f]{12,})$/i.test(value);
}

function usefulTitleHeading(title) {
  const value = String(title || "").trim();
  return value && !/^(?:main|introduction|question\s*\d*|q\d+|problem\s*\d*)$/i.test(value) ? value : "";
}

function inferredAcademicSubject(content) {
  const source = String(content || "");
  // Prefer the broad course/topic signal over one local construction.  The
  // assignment regression is about an idempotent linear map, but its document
  // title should remain "Linear Algebra Assignment", not "Projectors".
  if (/\bvector space\b/i.test(source) && /\blinear transformation\b/i.test(source)) return "Linear Algebra";
  if (/\bidempotent\b/i.test(source) || /\b([A-Z])\s*\^\s*2\s*=\s*\1\b/.test(source)) return "Projectors";
  return "";
}

function roleAwareFallbackTitle(heading, role) {
  const subject = usefulTitleHeading(heading);
  const workRole = String(role || "").trim();
  if (!subject) return !/^(?:article|document)$/i.test(workRole) ? workRole : "";
  if (!workRole || /^(?:article|document)$/i.test(workRole) || subject.toLowerCase().includes(workRole.toLowerCase())) return subject;
  return normalizeAgentTitle(`${subject} ${workRole}`);
}

// First Markdown H1 in the content (after meta stripping), used as a title
// candidate so exports stop defaulting to the bare filename.
function firstHeadingTitle(content) {
  const lines = String(content || "").replace(/\r\n?/g, "\n").split("\n");
  let inMeta = false;
  for (const line of lines) {
    if (/^#\+begin\s+meta\s*$/i.test(line)) { inMeta = true; continue; }
    if (inMeta) { if (/^#\+end\s+meta\s*$/i.test(line)) inMeta = false; continue; }
    const m = line.match(/^#\s+(.+?)\s*$/);
    if (m) return m[1].trim();
  }
  return "";
}

async function chooseMacSavePath(defaultPath, prompt = "Export LaTeX as:") {
  const fallback = resolveLatexOutputPath(defaultPath || join(homedir(), "Noema.tex"));
  const defaultDirectory = existsSync(dirname(fallback)) ? dirname(fallback) : homedir();
  // osascript runs as a background child of Emacs, so a bare `choose file name`
  // dialog opens *behind* the Emacs window and never receives focus (it looks
  // like nothing happened). Running it inside a `System Events` tell block with
  // `activate` forces the save dialog to the foreground.
  const script = [
    `set defaultPath to POSIX file ${JSON.stringify(defaultDirectory + "/")}`,
    'tell application "System Events"',
    "  activate",
    `  set chosenFile to choose file name with prompt ${JSON.stringify(prompt)} default name ${JSON.stringify(basename(fallback))} default location defaultPath`,
    "end tell",
    "POSIX path of chosenFile",
  ].join("\n");
  try {
    const { stdout } = await execFileAsync(executablePath("osascript"), ["-e", script], {
      timeout: 5 * 60 * 1000,
    });
    const selected = stdout.trim();
    const path = selected
      ? selected.toLowerCase().endsWith(".tex") ? selected : `${selected}.tex`
      : "";
    return path ? { ok: true, path } : { ok: false, canceled: true };
  } catch (err) {
    const message = String(err?.stderr || err?.message || "");
    if (/User canceled|cancelled/i.test(message)) return { ok: false, canceled: true };
    return { ok: false, message: message.trim() || "System save dialog failed" };
  }
}

function normalizedLatexOutputFile(outputPath) {
  const raw = String(outputPath || "").trim();
  if (!raw) throw new Error("Missing LaTeX output path");
  const requested = resolve(raw);
  return requested.toLowerCase().endsWith(".tex") ? requested : `${requested}.tex`;
}

function latexLogDiagnostics(log) {
  const lines = String(log || "").split(/\r?\n/);
  const fatal = lines.filter((line) =>
    /LaTeX Warning: (?:Citation|Reference).+undefined|There were undefined references|There were undefined citations|Missing character: There is no/i.test(line),
  );
  const layout = lines.filter((line) =>
    /Overfull \\[hv]box|Float too large|Too many unprocessed floats/i.test(line),
  );
  return {
    fatal: [...new Set(fatal)].slice(-20),
    layout: [...new Set(layout)].slice(-20),
  };
}

async function compileLatexExportPdf({ latex, outputPath, engine, sourceDir, supportFiles = [], signal }) {
  const latexBin = executablePath(engine === "xelatex" ? "xelatex" : engine === "lualatex" ? "lualatex" : "pdflatex");
  if (!latexBin || !existsSync(latexBin)) throw new Error(`LaTeX engine not found: ${engine}`);
  const finalTexFile = normalizedLatexOutputFile(outputPath);
  const buildDir = await runtimeMkdtemp("latex-pdf", finalTexFile);
  const texFile = join(buildDir, basename(finalTexFile));
  const env = { ...process.env };
  const searchDirs = [sourceDir, dirname(finalTexFile)].filter(Boolean).join("//:");
  if (searchDirs) env.TEXINPUTS = `${searchDirs}//:${env.TEXINPUTS || ""}`;
  const args = [
    "-interaction=nonstopmode",
    "-halt-on-error",
    "-file-line-error",
    `-output-directory=${buildDir}`,
    texFile,
  ];
  try {
    await writeFile(texFile, latex, "utf8");
    for (const file of supportFiles) {
      if (!file?.name || !file?.content) continue;
      await writeFile(join(buildDir, basename(file.name)), file.content);
    }
    // A second pass resolves references and the table of contents while all
    // auxiliary files and generated dependencies remain isolated from the
    // export directory. Nothing user-visible is replaced until both passes and
    // log linting have succeeded.
    throwIfAborted(signal);
    await execFileAsync(latexBin, args, { cwd: buildDir, env, timeout: 120_000, maxBuffer: 16 * 1024 * 1024, signal });
    throwIfAborted(signal);
    await execFileAsync(latexBin, args, { cwd: buildDir, env, timeout: 120_000, maxBuffer: 16 * 1024 * 1024, signal });
    throwIfAborted(signal);
    const builtPdf = join(buildDir, `${basename(texFile, extname(texFile))}.pdf`);
    const logFile = join(buildDir, `${basename(texFile, extname(texFile))}.log`);
    const log = await readFile(logFile, "utf8").catch(() => "");
    const diagnostics = latexLogDiagnostics(log);
    if (diagnostics.fatal.length > 0) {
      throw new Error(`LaTeX verification failed:\n${diagnostics.fatal.join("\n")}`);
    }
    return {
      pdf: await readFile(builtPdf),
      pdfFile: join(dirname(finalTexFile), `${basename(finalTexFile, extname(finalTexFile))}.pdf`),
      texFile: finalTexFile,
      warnings: diagnostics.layout,
    };
  } catch (err) {
    if (signal?.aborted || err?.name === "AbortError") {
      const canceled = new Error("LaTeX export canceled");
      canceled.name = "AbortError";
      throw canceled;
    }
    const logFile = join(buildDir, `${basename(texFile, extname(texFile))}.log`);
    let log = "";
    try { log = await readFile(logFile, "utf8"); } catch {}
    const detail = log.split(/\r?\n/).filter((line) => /^!|.*:[0-9]+:|error|undefined control/i.test(line)).slice(-12).join("\n");
    const message = String(err?.message || err);
    if (/^LaTeX verification failed:/.test(message)) throw err;
    throw new Error(`PDF compilation failed${detail ? `:\n${detail}` : `: ${message}`}`);
  } finally {
    await rm(buildDir, { recursive: true, force: true }).catch(() => {});
  }
}

// Parse the optional leading `% aaronnote-template: {json}` header that declares
// a template's display name, LaTeX engine, and extra `{{var}}` slots.
function parseLatexTemplateHeader(text, templateFile = "") {
  const match = String(text || "").match(/^%\s*aaronnote-template:\s*(\{.*\})\s*$/m);
  try {
    // Header metadata is optional for backwards compatibility, but the
    // structural template contract is not: every template, including a legacy
    // headerless one, must contain the body exactly once and may not reference
    // undeclared placeholders.
    const parsed = match ? JSON.parse(match[1]) : {};
    const engine = String(parsed?.engine || "").trim().toLowerCase();
    if (engine && !["pdflatex", "xelatex", "lualatex"].includes(engine)) throw new Error(`unsupported engine ${JSON.stringify(engine)}`);
    const documentRole = String(parsed?.documentRole || parsed?.name || "document").trim();
    if (!documentRole || /[\r\n]/.test(documentRole) || documentRole.length > 40) throw new Error("documentRole must be a short single-line label");
    const reserved = new Set(["title", "date", "source", "body", "macros"]);
    const ids = new Set();
    const vars = Array.isArray(parsed?.vars) ? parsed.vars.map((raw) => {
      const id = String(raw?.id || "").trim();
      if (!/^[A-Za-z][\w-]*$/.test(id)) throw new Error(`invalid variable id ${JSON.stringify(id)}`);
      if (reserved.has(id)) throw new Error(`reserved variable id ${JSON.stringify(id)}`);
      if (ids.has(id)) throw new Error(`duplicate variable id ${JSON.stringify(id)}`);
      ids.add(id);
      const input = String(raw?.input || raw?.type || "text").toLowerCase();
      if (!["text", "select"].includes(input)) throw new Error(`unsupported input type for ${id}: ${input}`);
      const escape = String(raw?.escape || "text").toLowerCase();
      if (!["text", "url", "raw"].includes(escape)) throw new Error(`unsupported escape mode for ${id}: ${escape}`);
      const options = Array.isArray(raw?.options) ? raw.options.map((option) => {
        if (typeof option === "string") return { value: option, label: option };
        return { value: String(option?.value ?? ""), label: String(option?.label ?? option?.value ?? "") };
      }).filter((option) => option.value) : [];
      const fallback = String(raw?.default ?? "");
      if (input === "select" && options.length === 0) throw new Error(`select variable ${id} requires options`);
      if (input === "select" && fallback && !options.some((option) => option.value === fallback)) throw new Error(`default for ${id} is not in options`);
      return {
        id,
        label: String(raw?.label || id).trim(),
        default: fallback,
        input,
        options,
        required: raw?.required === true,
        placeholder: String(raw?.placeholder || ""),
        description: String(raw?.description || ""),
        group: String(raw?.group || ""),
        escape,
      };
    }) : [];
    const sharedFiles = Array.isArray(parsed?.sharedFiles) ? parsed.sharedFiles.map((raw) => String(raw || "").trim()) : [];
    const sharedSeen = new Set();
    for (const file of sharedFiles) {
      if (!file || file !== basename(file) || file === "." || file === "..") throw new Error(`unsafe shared file ${JSON.stringify(file)}`);
      if (file === "aaronnote-macros.sty") throw new Error("sharedFiles may not override generated aaronnote-macros.sty");
      if (sharedSeen.has(file)) throw new Error(`duplicate shared file ${JSON.stringify(file)}`);
      sharedSeen.add(file);
    }
    const placeholders = [...String(text || "").matchAll(/\{\{\s*([A-Za-z][\w-]*)\s*\}\}/g)].map((token) => token[1]);
    if (placeholders.filter((key) => key === "body").length !== 1) throw new Error("template must contain {{body}} exactly once");
    const builtins = new Set(["title", "date", "source", "body"]);
    for (const key of new Set(placeholders)) {
      if (!builtins.has(key) && !ids.has(key)) throw new Error(`placeholder {{${key}}} has no declared variable`);
    }
    for (const id of ids) {
      if (!placeholders.includes(id)) throw new Error(`declared variable ${id} is not used by the template`);
    }
    return {
      name: String(parsed?.name || "").trim(),
      engine,
      documentRole,
      sharedFiles,
      vars,
    };
  } catch (error) {
    throw new Error(`Invalid LaTeX template header${templateFile ? ` in ${templateFile}` : ""}: ${String(error?.message || error)}`);
  }
}

function escapeLatexTemplateVariable(value, variable) {
  if (variable.escape === "raw") return String(value ?? "");
  if (variable.escape === "url") return escapeLatexUrl(value);
  return escapeLatexText(value);
}

async function latexTemplateSharedFiles(templateFile, names = []) {
  if (!templateFile || !Array.isArray(names) || names.length === 0) return [];
  const files = [];
  for (const name of names) {
    const source = join(dirname(templateFile), basename(name));
    let content;
    try { content = await readFile(source); } catch { throw new Error(`Missing LaTeX template dependency: ${source}`); }
    files.push({ name: basename(name), source, content });
  }
  return files;
}

async function syncLatexSharedFiles(files, targetDir) {
  if (!Array.isArray(files) || files.length === 0) return [];
  await mkdir(targetDir, { recursive: true });
  const synced = [];
  for (const file of files) {
    const target = join(targetDir, file.name);
    let current = null;
    try { current = await readFile(target); } catch {}
    if (current && current.equals(file.content)) {
      synced.push({ file: target, updated: false });
      continue;
    }
    const temporary = join(targetDir, `.${file.name}.${process.pid}.${Date.now()}.tmp`);
    try {
      await writeFile(temporary, file.content);
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
    synced.push({ file: target, updated: true });
  }
  return synced;
}

export async function listLatexTemplates() {
  const seen = new Map();
  for (const sub of ["latex", "tex"]) {
    const dir = join(latexTemplatesRoot, sub);
    let entries = [];
    try { entries = await readdir(dir); } catch { continue; }
    for (const name of entries.sort()) {
      if (!name.toLowerCase().endsWith(".tex")) continue;
      const key = name.replace(/\.tex$/i, "");
      if (seen.has(key)) continue; // latex/ takes precedence over tex/
      const file = join(dir, name);
      let text = "";
      try { text = await readFile(file, "utf8"); } catch { continue; }
      let header;
      try { header = parseLatexTemplateHeader(text, file); } catch { continue; }
      seen.set(key, {
        key,
        file,
        name: header.name || key,
        engine: header.engine || "pdflatex",
        documentRole: header.documentRole,
        vars: header.vars,
        sharedFiles: header.sharedFiles,
      });
    }
  }
  const templates = [...seen.values()].sort((a, b) =>
    a.key === "noema-article" ? -1 : b.key === "noema-article" ? 1 : a.name.localeCompare(b.name),
  );
  return { type: "latex-templates", ok: true, templates, root: latexTemplatesRoot };
}

export async function latexExportDefaults(body = {}) {
  const sourceFile = latexExportSourceFile(body.file || body.sourceFile || "");
  const state = await readLatexExportState();
  const paths = state.paths && typeof state.paths === "object" ? state.paths : {};
  const templates = state.templates && typeof state.templates === "object" ? state.templates : {};
  const remembered = templates[sourceFile] && typeof templates[sourceFile] === "object" ? templates[sourceFile] : null;
  const title = latexExportTitle(sourceFile, body.title || "", "");
  return {
    type: "latex-export-defaults",
    ok: true,
    file: sourceFile,
    outputPath: paths[sourceFile] || defaultLatexOutputPath(sourceFile, title),
    templateRoot: latexTemplatesRoot,
    template: remembered?.templatePath || "",
    vars: remembered?.vars && typeof remembered.vars === "object" ? remembered.vars : {},
  };
}

export async function latexExportAgentStatus() {
  await applyLatexExportSettingsFromState();
  return latexExportAgentStatusPayload();
}

export async function setLatexExportAgent(body = {}) {
  const agent = normalizeLatexExportAgent(body.agent || body.backend);
  if (!agent) {
    const err = new Error(`Unsupported LaTeX export agent: ${String(body.agent || body.backend || "")}`);
    err.statusCode = 400;
    throw err;
  }
  latexExportAgent = agent;
  const requestedEngine = normalizeLatexExportEngine(body.engine);
  if (requestedEngine) {
    latexExportEngine = requestedEngine;
  } else if (body.enableAgent !== false) {
    latexExportEngine = "codex";
  }

  await updateLatexExportState((state) => ({
    ...state,
    schemaVersion: 1,
    settings: {
      ...(state.settings && typeof state.settings === "object" ? state.settings : {}),
      latexExportAgent,
      latexExportEngine,
    },
    updatedAt: new Date().toISOString(),
  }));
  return latexExportAgentStatusPayload();
}

export async function chooseLatexOutputPath(body = {}) {
  const defaults = await latexExportDefaults(body);
  const defaultPath = resolveLatexOutputPath(body.defaultPath || defaults.outputPath, defaults.file);
  if (process.platform === "darwin") {
    return {
      type: "latex-output-path",
      ...await chooseMacSavePath(defaultPath),
      defaultPath,
    };
  }
  return {
    type: "latex-output-path",
    ok: false,
    defaultPath,
    message: "System save dialog is only implemented for macOS in this host",
  };
}

export async function exportLatex(body = {}) {
  const signal = body.signal;
  throwIfAborted(signal);
  await applyLatexExportSettingsFromState();
  const sourceFile = latexExportSourceFile(body.file || body.sourceFile || "");
  const contentWasProvided = typeof body.content === "string";
  const content = contentWasProvided
    ? body.content
    : sourceFile
      ? await readFile(sourceFile, "utf8")
      : "";
  // A scope export has two distinct inputs: CONTENT is the exact selected body,
  // while DOCUMENT-CONTENT supplies live (possibly unsaved) note metadata such
  // as title/date/bib. Older clients omit it, so fall back to the source file.
  const documentContent = typeof body.documentContent === "string"
    ? body.documentContent
    : contentWasProvided && sourceFile
      ? await readFile(sourceFile, "utf8")
      : content;
  if (!content.trim()) {
    const err = new Error("No Noema content to export");
    err.statusCode = 400;
    throw err;
  }

  const onProgress = typeof body.onProgress === "function" ? body.onProgress : null;
  const emit = (text) => { if (onProgress && text) { try { onProgress(text); } catch {} } };

  // 1. Mechanical base conversion, extended by any agent-maintained rules.
  emit("Converting with Pandoc…");
  const rules = await loadAgentRules(latexAgentDir);
  const bibliography = await bibliographyForDocument({ file: sourceFile, content, metadataContent: documentContent });
  const bibliographyIssues = bibliographyExportIssues(bibliography);
  if (bibliographyIssues.length > 0) {
    const error = new Error(`LaTeX export blocked by citation preflight:\n${bibliographyIssues.join("\n")}`);
    error.statusCode = 422;
    throw error;
  }
  const citationMaps = latexCitationMaps(bibliography);
  const converted = await aaronnoteMarkdownToLatexPandoc(content, {
    sourceFile,
    sourceDir: sourceFile ? dirname(sourceFile) : "",
    pandocBin: executablePath("pandoc"),
    rules,
    citationKeyMap: citationMaps.byNamespaceKey,
    signal,
  });
  throwIfAborted(signal);
  const documentMeta = extractAaronnoteMetadata(documentContent);
  const metaTitle = String(documentMeta.title || converted.meta.title || "").trim();
  const title = latexExportTitle(sourceFile, body.title || "", metaTitle);
  const defaults = await latexExportDefaults({ file: sourceFile, title });
  const outputPath = resolveLatexOutputPath(body.outputPath || defaults.outputPath, sourceFile);
  if (!outputPath) {
    const err = new Error("Missing LaTeX output path");
    err.statusCode = 400;
    throw err;
  }

  const requestedTemplate = String(body.templatePath || "").trim();
  const template = await readLatexTemplate(latexTemplatesRoot, requestedTemplate);
  if (requestedTemplate && (!template.file || resolve(template.file) !== resolve(requestedTemplate))) {
    throw new Error(`Selected LaTeX template could not be read: ${resolve(requestedTemplate)}`);
  }
  const header = parseLatexTemplateHeader(template.text, template.file);
  const engine = String(body.engine || header.engine || "pdflatex").toLowerCase();
  if (!["pdflatex", "xelatex", "lualatex"].includes(engine)) throw new Error(`Unsupported LaTeX engine: ${engine}`);
  const macroResult = loadKatexMacros(katexMacrosRoot);
  const declaredSharedFiles = await latexTemplateSharedFiles(template.file, header.sharedFiles);
  const generatedSharedFiles = template.text.includes("\\usepackage{aaronnote-macros}")
    ? [{ name: "aaronnote-macros.sty", content: Buffer.from(latexMacrosPackage(macroResult.macros, converted.features), "utf8") }]
    : [];
  const sharedFiles = [...declaredSharedFiles, ...generatedSharedFiles];
  throwIfAborted(signal);

  // A document title is a compact label, not a content synopsis. Preserve the
  // user's naming first; only infer from work type/content when it is generic.
  const filenameTitle = latexExportTitle(sourceFile, body.title || "", "");
  const sourceNameTitle = latexSourceNameTitle(sourceFile, body.title || "");
  const keepSourceTitle = meaningfulSourceTitle(sourceNameTitle);
  const docTitle = metaTitle
    || (keepSourceTitle ? sourceNameTitle : "")
    || roleAwareFallbackTitle(usefulTitleHeading(firstHeadingTitle(content)) || inferredAcademicSubject(content), header.name)
    || filenameTitle
    || "Noema";

  // Extra template variables declared in the header, merged with caller values.
  const rawTemplateVars = {};
  const extraVars = {};
  for (const v of header.vars) {
    const raw = String((body.vars && body.vars[v.id] != null ? body.vars[v.id] : v.default) ?? "");
    if (v.required && !raw.trim()) throw new Error(`Missing required LaTeX template field: ${v.label || v.id}`);
    rawTemplateVars[v.id] = raw;
    extraVars[v.id] = escapeLatexTemplateVariable(raw, v);
  }
  const assemble = (bodyLatex, titleOverride = "") => applyLatexTemplate(template.text, {
    ...extraVars,
    title: escapeLatexTitle(String(titleOverride || docTitle)),
    date: escapeLatexTitle(documentMeta.date || converted.meta.date || new Date().toISOString().slice(0, 10)),
    source: escapeLatexTitle(sourceFile ? displayPathForFile(sourceFile) : ""),
    body: bodyLatex,
  });

  // 2. Optional agent polish of the draft, gated on compilation, with fallback.
  const bibliographyLatex = bibliographyReferencesToLatex(bibliography.references || [], citationMaps.byId);
  let bodyLatex = `${converted.body}${bibliographyLatex}`;
  let engineUsed = "pandoc";
  let agentSummary = null;
  const warnings = Array.isArray(converted.warnings) ? [...converted.warnings] : [];
  for (const diagnostic of bibliography.diagnostics || []) {
    warnings.push(`Bibliography: ${diagnostic}`);
  }
  for (const citation of bibliography.citations || []) {
    const label = `${String(citation.namespace || "").trim()}:${(citation.keys || []).join(";")}`.replace(/^:/, "");
    for (const diagnostic of citation.diagnostics || []) {
      warnings.push(`Citation ${label || "(?)"}: ${diagnostic}`);
    }
  }
  const backend = ["codex", "claude", "opencode"].includes(latexExportAgent) ? latexExportAgent : "codex";
  const agentBin = executablePath(backend === "claude" ? latexClaudeBin : backend === "opencode" ? latexOpencodeBin : latexCodexBin);
  const wantAgent = latexExportEngine !== "mechanical" && String(body.engine || "").toLowerCase() !== "mechanical";
  if (wantAgent && !agentAvailable(agentBin)) {
    const error = new Error(`Configured LaTeX polish agent is unavailable: ${backend} (${agentBin || "no executable"})`);
    error.statusCode = 503;
    throw error;
  }
  if (wantAgent) {
    const latexBin = executablePath(engine === "xelatex" ? "xelatex" : engine === "lualatex" ? "lualatex" : "pdflatex");
    const result = await polishBodyWithAgent({
      sourceMarkdown: content,
      draftBody: bodyLatex,
      templateText: template.text,
      styleDoc: join(appDir, "docs", "latex-export-style.md"),
      syntaxDoc: join(appDir, "docs", "typora-syntax-survey.md"),
      agentsDoc: join(latexAgentDir, "AGENTS.md"),
      assemble,
      engine,
      latexBin,
      backend,
      agentBin,
      model: latexExportModel || (backend === "codex" ? latexCodexModel : ""),
      needsTitle: false,
      sourceTitle: sourceNameTitle,
      documentRole: header.documentRole || header.name || "Document",
      supportFiles: sharedFiles,
      skillsDir: join(latexAgentDir, "skills"),
      sourceDir: sourceFile ? dirname(sourceFile) : "",
      makeWorkdir: () => runtimeMkdtemp("latex-export", sourceFile || "export"),
      maxAttempts: latexExportMaxAttempts,
      polishVerifiedDraft: true,
      agentTimeoutMs: latexExportAgentIdleTimeoutMs,
      agentHardTimeoutMs: latexExportAgentHardTimeoutMs,
      onProgress,
      signal,
    });
    throwIfAborted(signal);
    if (!result.usedAgent || !result.compiled) {
      const details = Array.isArray(result.warnings) ? result.warnings.filter(Boolean) : [];
      const error = new Error([
        `${backend} did not produce a LaTeX body that passed review, fidelity, and compile gates.`,
        ...details,
      ].join("\n"));
      error.statusCode = 502;
      throw error;
    }
    bodyLatex = result.body;
    engineUsed = result.usedAgent ? backend : "pandoc";
    const decisions = Array.isArray(result.review?.decisions) ? result.review.decisions : [];
    agentSummary = {
      backend,
      attempts: result.attempts,
      elapsedMs: result.agentElapsedMs || 0,
      applied: decisions.filter((decision) => decision?.action === "applied").length,
      kept: decisions.filter((decision) => decision?.action === "kept").length,
      decisions,
      summary: result.agentSummary || "",
    };
    if (Array.isArray(result.warnings)) warnings.push(...result.warnings);
  }

  emit("Verifying final PDF…");
  throwIfAborted(signal);
  const latex = assemble(bodyLatex);
  const verified = await compileLatexExportPdf({
    latex,
    outputPath,
    engine,
    sourceDir: sourceFile ? dirname(sourceFile) : "",
    supportFiles: sharedFiles,
    signal,
  });
  if (verified.warnings.length > 0) warnings.push(...verified.warnings.map((line) => `LaTeX layout: ${line}`));

  // Commit only after staging completed both compiler passes and log linting.
  // Thus a failed export leaves the previous .tex/PDF untouched.
  emit("Committing verified .tex and PDF…");
  const sharedFileState = await syncLatexSharedFiles(sharedFiles, dirname(verified.texFile));
  const file = await writeLatexExport(verified.texFile, latex);
  await atomicWriteFile(verified.pdfFile, verified.pdf);
  const pdfFile = verified.pdfFile;
  throwIfAborted(signal);

  await updateLatexExportState((state) => {
    const paths = { ...(state.paths && typeof state.paths === "object" ? state.paths : {}) };
    if (sourceFile) paths[sourceFile] = file;
    const templates = { ...(state.templates && typeof state.templates === "object" ? state.templates : {}) };
    if (sourceFile) templates[sourceFile] = { templatePath: template.file, vars: rawTemplateVars };
    return { ...state, schemaVersion: 1, paths, templates, updatedAt: new Date().toISOString() };
  });

  emit("Done");
  return {
    type: "latex-export",
    ok: true,
    file,
    pdfFile,
    sourceFile,
    title: docTitle,
    template: template.file,
    engine: engineUsed,
    agent: agentSummary,
    warnings,
    sharedFiles: sharedFileState,
    bytes: Buffer.byteLength(latex, "utf8"),
  };
}

export function offsetToPosition(text, offset) {
  const source = String(text || "");
  const target = Math.max(0, Math.min(Number(offset) || 0, source.length));
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < target; i++) {
    if (source.charCodeAt(i) !== 10) continue;
    line++;
    lineStart = i + 1;
  }
  return { line, character: target - lineStart };
}

export function positionToOffset(text, position) {
  const source = String(text || "");
  const targetLine = Math.max(0, Number(position?.line) || 0);
  const targetChar = Math.max(0, Number(position?.character) || 0);
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < source.length && line < targetLine; i++) {
    if (source.charCodeAt(i) !== 10) continue;
    line++;
    lineStart = i + 1;
  }
  let lineEnd = source.indexOf("\n", lineStart);
  if (lineEnd < 0) lineEnd = source.length;
  return Math.max(lineStart, Math.min(lineStart + targetChar, lineEnd));
}

function languageIdForFile(file) {
  const ext = extname(String(file || "")).toLowerCase();
  if (ext === ".md" || ext === ".markdown") return "markdown";
  if (ext === ".typ") return "typst";
  if (ext === ".ts") return "typescript";
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return "javascript";
  if (ext === ".json") return "json";
  if (ext === ".tex") return "latex";
  if (ext === ".lean") return "lean";
  return "plaintext";
}

function copilotUriForFile(file) {
  if (typeof file === "string" && file.trim()) {
    try {
      return pathToFileURL(safeOpenFile(file)).href;
    } catch {}
  }
  return pathToFileURL(join(runtimeTmpRoot || aaronnoteTmpRoot(), "copilot", "aaronnote-copilot.md")).href;
}

function copilotClientId(body = {}) {
  return String(body?.clientId || body?.client || "").trim();
}

function copilotBodyActive(body = {}) {
  return body?.active !== false && body?.focused !== false;
}

function copilotSupersededError(error) {
  const code = error?.code ?? error?.data?.code;
  const message = String(error?.message || error?.data?.message || "");
  return code === -32802 || /superseded by a new request/i.test(message);
}

function uniqueExistingCommands(commands) {
  const seen = new Set();
  const out = [];
  for (const cmd of commands) {
    const key = `${cmd.command}\0${cmd.args.join("\0")}`;
    if (seen.has(key)) continue;
    if (cmd.mustExist && !existsSync(cmd.mustExist)) continue;
    seen.add(key);
    out.push(cmd);
  }
  return out;
}

function unpackedAsarPath(file) {
  return String(file || "").replace(/\.asar(?=$|[\\/])/, ".asar.unpacked");
}

function nodeCommand() {
  if (process.env.AARONNOTE_NODE) return process.env.AARONNOTE_NODE;
  if (process.versions?.electron) return "node";
  return process.execPath;
}

function appendCopilotLog(event, detail = {}) {
  copilotLog.push({
    at: new Date().toISOString(),
    event,
    ...detail,
  });
  if (copilotLog.length > 200) copilotLog = copilotLog.slice(-200);
}

function pushCopilotLog(event, detail = {}) {
  if (!copilotLogRecording) return;
  appendCopilotLog(event, detail);
}

function setCopilotLogRecording(enabled, options = {}) {
  if (options.clear) copilotLog = [];
  copilotLogRecording = enabled;
  appendCopilotLog(enabled ? "recording-started" : "recording-stopped", {});
}

function rawCopilotServerCommands() {
  if (COPILOT_DISABLE_LOCAL) return [];
  const configured = process.env.AARONNOTE_COPILOT_LANGUAGE_SERVER;
  if (configured) return [{ command: configured, args: ["--stdio"] }];
  const binFile = join(appDir, "node_modules", ".bin", "copilot-language-server");
  const serverFile = join(appDir, "node_modules", "@github", "copilot-language-server", "dist", "language-server.js");
  const unpackedBin = unpackedAsarPath(binFile);
  const unpackedServer = unpackedAsarPath(serverFile);
  const resourceServer = process.resourcesPath
    ? join(process.resourcesPath, "app.asar.unpacked", "node_modules", "@github", "copilot-language-server", "dist", "language-server.js")
    : "";
  const commands = [];
  if (!appDir.includes(".asar")) {
    commands.push(
      { command: binFile, args: ["--stdio"], mustExist: binFile },
      { command: nodeCommand(), args: [serverFile, "--stdio"], mustExist: serverFile },
    );
  }
  for (const file of [unpackedBin, unpackedServer, resourceServer]) {
    if (!file) continue;
    if (process.versions?.electron) {
      commands.push({
        command: process.execPath,
        args: [file, "--stdio"],
        env: { ELECTRON_RUN_AS_NODE: "1" },
        mustExist: file,
      });
    } else {
      commands.push({ command: file, args: ["--stdio"], mustExist: file });
      commands.push({ command: nodeCommand(), args: [file, "--stdio"], mustExist: file });
    }
  }
  return commands;
}

function copilotServerCommands() {
  return uniqueExistingCommands(rawCopilotServerCommands());
}

function copilotDiagnostics() {
  return {
    type: "copilot-log",
    now: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
    execPath: process.execPath,
    nodeCommand: nodeCommand(),
    electron: process.versions?.electron || "",
    appDir,
    childProcessCwd: copilotProcessCwd(),
    workspaceRoot,
    noteRoot,
    resourcesPath: process.resourcesPath || "",
    logRecording: copilotLogRecording,
    env: {
      AARONNOTE_EMACS_GATEWAY: COPILOT_BRIDGE_REQUEST ? "connected" : "",
      AARONNOTE_COPILOT_DISABLE_LOCAL: process.env.AARONNOTE_COPILOT_DISABLE_LOCAL || "",
      AARONNOTE_COPILOT_LANGUAGE_SERVER: process.env.AARONNOTE_COPILOT_LANGUAGE_SERVER || "",
      AARONNOTE_NODE: process.env.AARONNOTE_NODE || "",
      ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE || "",
      PATH: process.env.PATH || "",
    },
    rawCommands: rawCopilotServerCommands().map((cmd) => ({
      command: cmd.command,
      args: cmd.args,
      env: cmd.env || {},
      mustExist: cmd.mustExist || "",
      exists: cmd.mustExist ? existsSync(cmd.mustExist) : existsSync(cmd.command),
    })),
    runnableCommands: copilotServerCommands().map((cmd) => ({
      command: cmd.command,
      args: cmd.args,
      env: cmd.env || {},
      mustExist: cmd.mustExist || "",
    })),
    client: copilotClient
      ? copilotClient.kind === "emacs-bridge"
        ? {
            kind: copilotClient.kind,
            url: copilotClient.url,
            status: copilotClient.status,
            pending: copilotClient.pending?.size || 0,
          }
        : {
          hasProcess: !!copilotClient.proc,
          pid: copilotClient.proc?.pid || 0,
          status: copilotClient.status,
          pending: copilotClient.pending?.size || 0,
          documents: copilotClient.documents?.size || 0,
          clients: copilotClient.clientDocuments?.size || 0,
          focusedUri: copilotClient.focusedUri || "",
          focusedClient: copilotClient.focusedClient || "",
          notifiedFocusedUri: copilotClient.notifiedFocusedUri || "",
        }
      : null,
    log: copilotLog,
  };
}

function openExternalUri(uri) {
  if (!/^https?:\/\//i.test(String(uri || ""))) return;
  pushCopilotLog("open-uri", { uri });
  if (process.platform === "darwin") {
    execFile("open", [uri], () => {});
  }
  return uri;
}

function findFirstExternalUri(value, depth = 0) {
  if (depth > 5 || value == null) return "";
  if (typeof value === "string") return /^https?:\/\//i.test(value) ? value : "";
  if (Array.isArray(value)) {
    for (const item of value) {
      const uri = findFirstExternalUri(item, depth + 1);
      if (uri) return uri;
    }
    return "";
  }
  if (typeof value === "object") {
    for (const item of Object.values(value)) {
      const uri = findFirstExternalUri(item, depth + 1);
      if (uri) return uri;
    }
  }
  return "";
}

function findStringByKey(value, pattern, depth = 0) {
  if (depth > 5 || value == null || typeof value !== "object") return "";
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStringByKey(item, pattern, depth + 1);
      if (found) return found;
    }
    return "";
  }
  for (const [key, item] of Object.entries(value)) {
    if (pattern.test(key) && typeof item === "string" && item) return item;
    const found = findStringByKey(item, pattern, depth + 1);
    if (found) return found;
  }
  return "";
}

function deviceCodeFromText(text) {
  const value = String(text || "");
  const match = value.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/i) || value.match(/\b([A-Z0-9]{8})\b/i);
  return match ? match[1].toUpperCase().replace(/^([A-Z0-9]{4})([A-Z0-9]{4})$/, "$1-$2") : "";
}

function copilotProcessCwd() {
  if (appDir.includes(".asar")) return dirname(appDir);
  return appDir;
}

// How long the Copilot LSP may sit unused before `armIdleTimer` stops it.
// It restarts transparently on the next request via `ensureReady`. 0 disables.
const COPILOT_IDLE_TTL_MS = durationFromEnv("AARONNOTE_COPILOT_IDLE_TTL_MS", 15 * 60 * 1000);
const COPILOT_IDLE_CHECK_MS = 30_000;
// When Noema is launched from Emacs, Copilot requests should use Emacs'
// existing copilot.el JSON-RPC connection instead of starting a second
// @github/copilot-language-server process in web-host.
const COPILOT_DISABLE_LOCAL = process.env.AARONNOTE_COPILOT_DISABLE_LOCAL === "1";
let COPILOT_BRIDGE_REQUEST = null;

export function configureCopilotBridgeRequest(request) {
  COPILOT_BRIDGE_REQUEST = typeof request === "function" ? request : null;
}

// Used only by the local fallback LSP. Emacs-launched Noema forwards
// Copilot requests to copilot.el through the shared gateway.
const COPILOT_MAX_HEAP_MB = Math.max(0, Number(process.env.AARONNOTE_COPILOT_MAX_HEAP_MB) || 0);

class EmacsCopilotBridgeClient {
  constructor(request) {
    this.kind = "emacs-bridge";
    this.url = "emacs-gateway";
    this.request = request;
    this.status = { message: "Using Emacs Copilot bridge", kind: "Normal", busy: false };
    this.pending = new Set();
  }

  async post(action, body = {}) {
    const pending = { action };
    this.pending.add(pending);
    try {
      const value = await this.request("copilot.request", { action, body });
      if (value?.status) this.status = value.status;
      return value;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.status = { message, kind: "Error", busy: false };
      return { ok: false, message, status: this.status };
    } finally {
      this.pending.delete(pending);
    }
  }

  inline(body) { return this.post("inline", body); }
  shown(body) { return this.post("shown", body); }
  accept(body) { return this.post("accept", body); }
  focus(body) { return this.post("focus", body); }
  blur(body) { return this.post("blur", body); }
  close(body) { return this.post("close", body); }
  signIn() { return this.post("sign-in", {}); }
  signOut() { return this.post("sign-out", {}); }
  quota() { return this.post("quota", {}); }
  statusRequest() { return this.post("status", {}); }
  log(body) { return this.post("log", body || {}); }
  stop() {}
}

class CopilotLspClient {
  constructor() {
    this.proc = null;
    this.buffer = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map();
    this.documents = new Map();
    this.clientDocuments = new Map();
    this.focusedUri = "";
    this.focusedClient = "";
    this.notifiedFocusedUri = "";
    this.status = { message: "Not started", kind: "Inactive", busy: false };
    this.ready = null;
    this.lastAuthCode = "";
    this.lastAuthMessage = "";
    this.lastActivity = Date.now();
    this.idleTimer = null;
  }

  touchActivity() {
    this.lastActivity = Date.now();
  }

  armIdleTimer() {
    clearInterval(this.idleTimer);
    this.idleTimer = null;
    if (!(COPILOT_IDLE_TTL_MS > 0)) return;
    this.idleTimer = setInterval(() => {
      if (!this.proc || this.pending.size > 0 || this.status.busy) return;
      if (Date.now() - this.lastActivity < COPILOT_IDLE_TTL_MS) return;
      pushCopilotLog("idle-shutdown", { idleMs: Date.now() - this.lastActivity });
      this.stop();
    }, COPILOT_IDLE_CHECK_MS);
    this.idleTimer.unref?.();
  }

  async ensureReady() {
    if (this.ready) return this.ready;
    this.ready = this.start();
    return this.ready;
  }

  async start() {
    const commands = copilotServerCommands();
    pushCopilotLog("start", { commands: commands.map((cmd) => ({ command: cmd.command, args: cmd.args, env: cmd.env || {} })) });
    if (commands.length === 0) {
      pushCopilotLog("missing-server", { rawCommands: copilotDiagnostics().rawCommands });
      throw new Error(COPILOT_DISABLE_LOCAL
        ? "Copilot local language server is disabled; Emacs Copilot bridge is unavailable."
        : "Copilot language server is unavailable. Set AARONNOTE_COPILOT_LANGUAGE_SERVER to Emacs's copilot-server-executable.");
    }
    let lastError = null;
    for (const cmd of commands) {
      try {
        await this.startCommand(cmd);
        pushCopilotLog("started", { command: cmd.command, args: cmd.args, pid: this.proc?.pid || 0 });
        return;
      } catch (err) {
        lastError = err;
        pushCopilotLog("start-failed", {
          command: cmd.command,
          args: cmd.args,
          message: err instanceof Error ? err.message : String(err),
          code: err?.code || "",
        });
        this.stop();
      }
    }
    throw lastError ?? new Error("Copilot language server failed to start");
  }

  failPending(err) {
    for (const pending of this.pending.values()) pending.reject(err);
    this.pending.clear();
  }

  async startCommand(cmd) {
    const env = { ...process.env, ...(cmd.env || {}) };
    if (COPILOT_MAX_HEAP_MB > 0) {
      env.NODE_OPTIONS = [env.NODE_OPTIONS, `--max-old-space-size=${COPILOT_MAX_HEAP_MB}`]
        .filter(Boolean)
        .join(" ");
    }
    const proc = spawn(cmd.command, cmd.args, {
      cwd: copilotProcessCwd(),
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    pushCopilotLog("spawn", { command: cmd.command, args: cmd.args, cwd: copilotProcessCwd(), env: cmd.env || {}, pid: proc.pid || 0 });
    this.proc = proc;
    proc.stdout.on("data", (chunk) => this.receive(chunk));
    proc.stderr.on("data", (chunk) => {
      const msg = String(chunk || "").trim();
      if (msg) {
        pushCopilotLog("stderr", { message: msg });
        console.warn(`Copilot LSP: ${msg}`);
      }
    });
    proc.once("error", (err) => {
      if (this.proc !== proc) return;
      pushCopilotLog("error", { message: err.message, code: err.code || "" });
      this.failPending(err);
      this.proc = null;
      this.ready = null;
      this.status = { message: err.message, kind: "Error", busy: false };
    });
    proc.once("exit", (code, signal) => {
      if (this.proc !== proc) return;
      const err = new Error(`Copilot language server exited (${signal || (code ?? "unknown")})`);
      pushCopilotLog("exit", { code, signal });
      this.failPending(err);
      this.proc = null;
      this.ready = null;
      this.documents.clear();
      this.clientDocuments.clear();
      this.focusedUri = "";
      this.focusedClient = "";
      this.notifiedFocusedUri = "";
      this.status = { message: err.message, kind: "Error", busy: false };
    });

    await this.request("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(workspaceRoot).href,
      workspaceFolders: [{ uri: pathToFileURL(workspaceRoot).href, name: basename(workspaceRoot) || "workspace" }],
      capabilities: {
        workspace: { workspaceFolders: true, configuration: true },
        window: { showDocument: { support: true } },
        textDocument: {},
      },
      initializationOptions: {
        editorInfo: { name: "Noema", version: "0.3.1" },
        editorPluginInfo: { name: "Noema Copilot", version: "0.1.0" },
      },
    });
    this.notify("initialized", {});
    this.notify("workspace/didChangeConfiguration", {
      settings: {
        telemetry: { telemetryLevel: "all" },
      },
    });
    this.status = { message: "Ready", kind: "Normal", busy: false };
    this.touchActivity();
    this.armIdleTimer();
  }

  send(value) {
    if (!this.proc?.stdin?.writable) throw new Error("Copilot language server is not running");
    const body = Buffer.from(JSON.stringify(value), "utf8");
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8");
    this.proc.stdin.write(Buffer.concat([header, body]));
  }

  request(method, params) {
    const id = this.nextId++;
    this.send({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolveRequest, reject) => {
      this.pending.set(id, { resolve: resolveRequest, reject });
      windowSetTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.reject(new Error(`Copilot request timed out: ${method}`));
      }, 30_000);
    });
  }

  notify(method, params) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  respond(id, result, error = null) {
    if (error) this.send({ jsonrpc: "2.0", id, error });
    else this.send({ jsonrpc: "2.0", id, result });
  }

  receive(chunk) {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.slice(0, headerEnd).toString("utf8");
      const match = header.match(/content-length:\s*(\d+)/i);
      if (!match) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const start = headerEnd + 4;
      const end = start + length;
      if (this.buffer.length < end) return;
      const raw = this.buffer.slice(start, end).toString("utf8");
      this.buffer = this.buffer.slice(end);
      try {
        this.handle(JSON.parse(raw));
      } catch (err) {
        console.warn("Copilot LSP parse failed", err);
      }
    }
  }

  handle(message) {
    if (Object.prototype.hasOwnProperty.call(message, "id") && (Object.prototype.hasOwnProperty.call(message, "result") || message.error)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        const error = new Error(message.error.message || "Copilot request failed");
        error.code = message.error.code;
        error.data = message.error.data;
        pending.reject(error);
      }
      else pending.resolve(message.result);
      return;
    }
    if (message.method === "didChangeStatus") {
      this.status = message.params || this.status;
      return;
    }
    if (message.method === "window/logMessage") {
      const msg = message.params?.message;
      if (msg) console.warn(`Copilot LSP: ${msg}`);
      return;
    }
    if (message.method === "window/showDocument") {
      openExternalUri(message.params?.uri);
      this.respond(message.id, { success: true });
      return;
    }
    if (message.method === "workspace/configuration") {
      const items = Array.isArray(message.params?.items) ? message.params.items : [];
      this.respond(message.id, items.map(() => ({})));
      return;
    }
    if (message.method === "window/showMessageRequest") {
      const text = String(message.params?.message || "");
      const code = deviceCodeFromText(text);
      if (code) {
        this.lastAuthCode = code;
        this.lastAuthMessage = text;
      }
      pushCopilotLog("show-message-request", {
        message: text,
        code,
        actions: Array.isArray(message.params?.actions) ? message.params.actions : [],
      });
      const actions = Array.isArray(message.params?.actions) ? message.params.actions : [];
      this.respond(message.id, actions[0] ?? null);
      return;
    }
    if (Object.prototype.hasOwnProperty.call(message, "id")) {
      this.respond(message.id, null);
    }
  }

  closeDocument(uri, reason = "unreferenced") {
    const current = this.documents.get(uri);
    if (!current) return false;
    this.documents.delete(uri);
    if (this.focusedUri === uri) this.focusedUri = "";
    if (this.notifiedFocusedUri === uri) this.notifiedFocusedUri = "";
    if (this.proc?.stdin?.writable) {
      this.notify("textDocument/didClose", { textDocument: { uri } });
    }
    pushCopilotLog("document-close", { uri, file: current.file || "", reason });
    return true;
  }

  detachClient(clientId, reason = "close") {
    if (!clientId) return null;
    const previous = this.clientDocuments.get(clientId);
    if (!previous) return null;
    this.clientDocuments.delete(clientId);
    const wasFocused = this.focusedClient === clientId;
    if (wasFocused) {
      this.focusedClient = "";
      if (this.focusedUri === previous.uri) this.focusedUri = "";
    }
    const doc = this.documents.get(previous.uri);
    if (doc?.clients) {
      doc.clients.delete(clientId);
      doc.lastUsedAt = Date.now();
      if (doc.clients.size === 0 && this.focusedUri !== previous.uri) {
        this.closeDocument(previous.uri, reason);
      }
    }
    return previous;
  }

  attachClient(clientId, uri, file, state = "focused") {
    if (!clientId) return;
    const previous = this.clientDocuments.get(clientId);
    if (previous?.uri && previous.uri !== uri) this.detachClient(clientId, "switch-file");
    this.clientDocuments.set(clientId, {
      uri,
      file: String(file || ""),
      state,
      updatedAt: Date.now(),
    });
    const doc = this.documents.get(uri);
    if (doc?.clients) {
      doc.clients.add(clientId);
      doc.lastUsedAt = Date.now();
    }
  }

  markFocused(uri, clientId = "", file = "", notifyLsp = true) {
    if (clientId) this.attachClient(clientId, uri, file, "focused");
    this.focusedUri = uri;
    this.focusedClient = clientId;
    if (!notifyLsp || this.notifiedFocusedUri === uri || !this.documents.has(uri)) return;
    this.notify("textDocument/didFocus", { textDocument: { uri } });
    this.notifiedFocusedUri = uri;
    pushCopilotLog("document-focus", { uri, file: String(file || ""), clientId });
  }

  markBlurred(body = {}) {
    const clientId = copilotClientId(body);
    if (!clientId) return { ok: true, focused: this.focusedClient || "" };
    const current = this.clientDocuments.get(clientId);
    if (current) {
      this.clientDocuments.set(clientId, {
        ...current,
        state: "blurred",
        updatedAt: Date.now(),
      });
    }
    if (this.focusedClient === clientId) {
      this.focusedClient = "";
      if (this.focusedUri === current?.uri) this.focusedUri = "";
    }
    pushCopilotLog("client-blur", { clientId, file: String(body?.file || current?.file || "") });
    return { ok: true, focused: this.focusedClient || "" };
  }

  markClosed(body = {}) {
    const clientId = copilotClientId(body);
    const previous = this.detachClient(clientId, "client-close");
    pushCopilotLog("client-close", {
      clientId,
      file: String(body?.file || previous?.file || ""),
      uri: previous?.uri || "",
      clients: this.clientDocuments.size,
    });
    return { ok: true, closed: Boolean(previous), clients: this.clientDocuments.size };
  }

  markClientFocus(body = {}) {
    const file = String(body.file || "");
    const uri = copilotUriForFile(file);
    const clientId = copilotClientId(body);
    this.markFocused(uri, clientId, file, false);
    pushCopilotLog("client-focus", { clientId, file, uri });
    return { ok: true, focused: clientId, uri };
  }

  clientMayRequestInline(body, uri) {
    if (!copilotBodyActive(body)) return false;
    const clientId = copilotClientId(body);
    if (!clientId) return true;
    const current = this.clientDocuments.get(clientId);
    if (this.focusedClient && this.focusedClient !== clientId && current?.state !== "focused") return false;
    if (this.focusedUri && this.focusedUri !== uri && current?.state !== "focused") return false;
    return true;
  }

  syncDocument(uri, file, content, clientId = "") {
    const languageId = languageIdForFile(file);
    const current = this.documents.get(uri);
    if (!current) {
      const version = 1;
      const clients = new Set();
      if (clientId) clients.add(clientId);
      this.documents.set(uri, {
        version,
        content,
        languageId,
        file: String(file || ""),
        clients,
        openedAt: Date.now(),
        lastUsedAt: Date.now(),
      });
      this.notify("textDocument/didOpen", {
        textDocument: { uri, languageId, version, text: content },
      });
      pushCopilotLog("document-open", { uri, file: String(file || ""), clientId });
      return { version, languageId };
    }
    if (clientId && current.clients) current.clients.add(clientId);
    current.lastUsedAt = Date.now();
    if (current.content !== content) {
      const version = current.version + 1;
      this.notify("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{
          range: { start: { line: 0, character: 0 }, end: offsetToPosition(current.content, current.content.length) },
          rangeLength: current.content.length,
          text: content,
        }],
      });
      this.documents.set(uri, {
        ...current,
        version,
        content,
        languageId,
        file: String(file || current.file || ""),
        lastUsedAt: Date.now(),
      });
      return { version, languageId };
    }
    return { version: current.version, languageId: current.languageId };
  }

  async inline(body) {
    await this.ensureReady();
    this.touchActivity();
    const content = String(body.content || "");
    const file = String(body.file || "");
    const offset = Math.max(0, Math.min(Number(body.offset) || 0, content.length));
    const uri = copilotUriForFile(file);
    const clientId = copilotClientId(body);
    if (!this.clientMayRequestInline(body, uri)) {
      pushCopilotLog("inline-skipped", { uri, file, clientId, reason: "inactive-client" });
      return { type: "copilot-inline", items: [], status: this.status };
    }
    const { version } = this.syncDocument(uri, file, content, clientId);
    this.markFocused(uri, clientId, file, true);
    let result;
    try {
      result = await this.request("textDocument/inlineCompletion", {
        textDocument: { uri, version },
        position: offsetToPosition(content, offset),
        context: { triggerKind: 2 },
        formattingOptions: { tabSize: 2, insertSpaces: true },
      });
    } catch (err) {
      if (!copilotSupersededError(err)) throw err;
      pushCopilotLog("inline-superseded", { uri, file, clientId });
      return { type: "copilot-inline", items: [], status: this.status };
    }
    const item = Array.isArray(result?.items) ? result.items.find((candidate) => typeof candidate?.insertText === "string") : null;
    if (!item) return { type: "copilot-inline", items: [], status: this.status };
    const range = item.range
      ? {
          from: positionToOffset(content, item.range.start),
          to: positionToOffset(content, item.range.end),
        }
      : { from: offset, to: offset };
    return {
      type: "copilot-inline",
      items: [{
        insertText: item.insertText,
        range,
        item,
      }],
      status: this.status,
    };
  }

  async shown(body) {
    await this.ensureReady();
    this.touchActivity();
    if (body?.item) this.notify("textDocument/didShowCompletion", { item: body.item });
    return { ok: true };
  }

  async accept(body) {
    await this.ensureReady();
    this.touchActivity();
    const item = body?.item;
    if (!item) return { ok: false };
    const acceptedLength = Number(body.acceptedLength);
    if (Number.isFinite(acceptedLength) && acceptedLength >= 0 && acceptedLength < String(item.insertText || "").length) {
      this.notify("textDocument/didPartiallyAcceptCompletion", { item, acceptedLength });
      return { ok: true, partial: true };
    }
    if (item.command?.command) {
      await this.request("workspace/executeCommand", {
        command: item.command.command,
        arguments: Array.isArray(item.command.arguments) ? item.command.arguments : [],
      });
    }
    return { ok: true };
  }

  async signIn() {
    await this.ensureReady();
    this.lastAuthCode = "";
    this.lastAuthMessage = "";
    const result = await this.request("signIn", {});
    pushCopilotLog("sign-in-result", { result });
    const resultUri = findStringByKey(result, /^(verificationUri|verification_uri|verificationUriComplete|verification_uri_complete|uri|url)$/i)
      || findFirstExternalUri(result);
    const userCode = findStringByKey(result, /^(userCode|user_code|code)$/i) || this.lastAuthCode || deviceCodeFromText(this.lastAuthMessage);
    const openedUri = result?.status === "AlreadySignedIn"
      ? openExternalUri("https://github.com/settings/copilot")
      : openExternalUri(resultUri);
    if (result?.command?.command) {
      void this.request("workspace/executeCommand", {
        command: result.command.command,
        arguments: Array.isArray(result.command.arguments) ? result.command.arguments : [],
      }).catch((err) => {
        console.warn("Copilot sign-in command failed", err);
      });
    }
    const message = result?.status === "AlreadySignedIn"
      ? `Already signed in${result?.user ? ` as ${result.user}` : ""}; opened GitHub Copilot settings`
      : openedUri
        ? userCode
          ? `Opened GitHub login; code ${userCode}`
          : "Opened GitHub login"
        : userCode
          ? `Copilot login code ${userCode}`
          : "Copilot login did not return a device code";
    return { type: "copilot-sign-in", ...result, openedUri, userCode, message, status: this.status };
  }

  async signOut() {
    await this.ensureReady();
    await this.request("signOut", {});
    return { ok: true, status: this.status };
  }

  async quota() {
    await this.ensureReady();
    const result = await this.request("checkQuota", {}).catch((err) => ({ error: err.message }));
    return { type: "copilot-quota", result };
  }

  focus(body) {
    return this.markClientFocus(body || {});
  }

  blur(body) {
    return this.markBlurred(body || {});
  }

  close(body) {
    return this.markClosed(body || {});
  }

  stop() {
    clearInterval(this.idleTimer);
    this.idleTimer = null;
    this.documents.clear();
    this.clientDocuments.clear();
    this.focusedUri = "";
    this.focusedClient = "";
    this.notifiedFocusedUri = "";
    const proc = this.proc;
    this.proc = null;
    this.ready = null;
    if (!proc) return;
    proc.kill(); // SIGTERM
    // Escalate to SIGKILL after 2 s if the language server ignores SIGTERM.
    const fallback = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch (_) {}
    }, 2000);
    fallback.unref?.();
    proc.once("exit", () => clearTimeout(fallback));
  }
}

function windowSetTimeout(fn, ms) {
  return setTimeout(fn, ms);
}

function getCopilotClient() {
  if (!copilotClient) {
    copilotClient = COPILOT_BRIDGE_REQUEST
      ? new EmacsCopilotBridgeClient(COPILOT_BRIDGE_REQUEST)
      : new CopilotLspClient();
  }
  return copilotClient;
}

export async function shutdownCopilot() {
  if (copilotClient) {
    copilotClient.stop();
    copilotClient = null;
  }
}

export async function handleCopilotRequest(action, body = {}) {
  if (action === "log") {
    if (COPILOT_BRIDGE_REQUEST) return getCopilotClient().log(body || {});
    if (body?.record === true) {
      setCopilotLogRecording(true, { clear: body?.clear !== false });
      return { ...copilotDiagnostics(), message: "Copilot log recording started" };
    }
    if (body?.record === false) {
      setCopilotLogRecording(false);
      return { ...copilotDiagnostics(), message: "Copilot logs recorded" };
    }
    return copilotDiagnostics();
  }
  const client = getCopilotClient();
  if (action === "inline") return client.inline(body);
  if (action === "shown") return client.shown(body);
  if (action === "accept") return client.accept(body);
  if (action === "focus") return client.focus(body);
  if (action === "blur") return client.blur(body);
  if (action === "close") return client.close(body);
  if (action === "sign-in") return client.signIn();
  if (action === "sign-out") return client.signOut();
  if (action === "quota") return client.quota();
  if (action === "status") {
    if (client.kind === "emacs-bridge") return client.statusRequest();
    await client.ensureReady();
    return { type: "copilot-status", status: client.status };
  }
  return { ok: false, message: "Unknown Copilot action" };
}

export async function readNote(file, options = {}) {
  if (externalFileProvider?.owns?.(file)) {
    const opened = await externalFileProvider.read(String(file));
    const content = String(opened?.content ?? "");
    const payload = {
      type: "open",
      file: String(opened?.file || file),
      title: titleFromContent(String(file), content),
      mode: modeForFile(String(file)),
      content,
      kind: kindFromContent(content),
      mtimeMs: Number(opened?.mtimeMs) || 0,
      size: Number(opened?.size) || Buffer.byteLength(content, "utf8"),
      standalone: true,
      remote: true,
    };
    if (options.includeIndex === true) {
      Object.assign(payload, await notesIndexPayload());
      payload.snippets = await scanSnippets();
      payload.templates = await scanTemplates();
    }
    return payload;
  }
  const safe = safeOpenFile(file);
  if (leanSourceFile(safe)) {
    const err = new Error("Lean files are edited manually");
    err.statusCode = 400;
    throw err;
  }
  noteScanRoot = scanRootForOpenFile(safe);
  const info = await stat(safe);
  if (!info.isFile()) {
    const err = new Error(`Not a regular file: ${safe}`);
    err.statusCode = 400;
    throw err;
  }
  const content = await readFile(safe, "utf8");
  const standalone = standaloneFile(safe);
  const payload = {
    type: "open",
    file: safe,
    title: titleFromContent(safe, content),
    mode: modeForFile(safe),
    content,
    kind: kindFromContent(content),
    mtimeMs: info.mtimeMs,
    size: info.size,
    standalone,
  };
  if (options.includeIndex === true) {
    Object.assign(payload, await notesIndexPayload());
    payload.snippets = await scanSnippets();
    payload.templates = await scanTemplates();
  }
  return payload;
}

function slidesMirrorPaths(file) {
  const safe = safeOpenFile(file);
  const stem = basename(safe, extname(safe)) || "slides";
  const dir = join(dirname(safe), ".slides");
  return {
    file: safe,
    dir,
    jsFile: join(dir, `${stem}.js`),
    cssFile: join(dir, `${stem}.css`),
  };
}

const defaultSlidesMirrorJs = `// Noema Reveal mirror for this note.
// The default export runs after Reveal has initialized and receives the live
// Reveal API, its root element, and the Markdown note path.
export default function ({ Reveal, root, file }) {
  void Reveal;
  void root;
  void file;
}
`;

const defaultSlidesMirrorCss = `/* Noema Reveal mirror for this note. */
`;

/**
 * Read (and on first use create) a note-local Reveal JS/CSS mirror.  The
 * browser executes the JS as a module only for the local note that requested
 * it; it is never fed back through the Markdown HTML sanitizer.
 */
export async function slidesMirror(body = {}) {
  const paths = slidesMirrorPaths(body.file);
  if (!existsSync(paths.jsFile)) await atomicWriteFile(paths.jsFile, defaultSlidesMirrorJs, "utf8");
  if (!existsSync(paths.cssFile)) await atomicWriteFile(paths.cssFile, defaultSlidesMirrorCss, "utf8");
  return {
    ok: true,
    file: paths.file,
    jsFile: paths.jsFile,
    cssFile: paths.cssFile,
    js: await readFile(paths.jsFile, "utf8"),
    css: await readFile(paths.cssFile, "utf8"),
  };
}

async function noteSummaryForFile(file, content = null) {
  const safe = safeOpenFile(file);
  const info = await stat(safe);
  const text = content == null ? await readFile(safe, "utf8") : String(content);
  const relPath = displayPathForScanRoot(safe, noteScanRoot);
  const groupKey = groupKeyFor(safe, noteScanRoot);
  const id = idFromContent(safe, noteScanRoot, text);
  const roam = hasRoamMeta(text);
  const note = {
    key: id,
    id,
    title: titleFromContent(safe, text),
    file: safe,
    link: relPath,
    path: relPath,
    ext: safe.slice(safe.lastIndexOf(".") + 1).toLowerCase(),
    kind: kindFromContent(text),
    date: dateFromContent(text),
    groupKey,
    groupLabel: groupLabelFor(groupKey),
    section: groupKey.includes(sep) ? groupKey.split(sep)[0] : groupKey,
    source: sourceFromContent(text),
    aliases: aliasesFromContent(text),
    summary: summaryFromContent(text),
    tags: tagsFromContent(text),
    inlineTags: inlineTagsFromContent(text),
    refs: refsFromContent(text),
    backlinks: [],
    roam,
    domTargets: [],
    standalone: standaloneFile(safe),
    mtimeMs: info.mtimeMs,
    size: info.size,
  };
  note.domTargets = domTargetsFromContent(text, note);
  return note;
}

function roamDbFile() {
  return join(noteRoot, "roam.db");
}

function roamSyncStateFile() {
  return join(stateRoot, "sync", "state.json");
}

async function readSyncState() {
  try {
    const raw = await readFile(roamSyncStateFile(), "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function writeSyncState(patch) {
  let current = {};
  try {
    const raw = await readFile(roamSyncStateFile(), "utf8");
    current = JSON.parse(raw);
  } catch {}
  const next = { ...current, ...patch };
  delete next.todoDbSchemaVersion;
  await atomicWriteFile(roamSyncStateFile(), JSON.stringify(next, null, 2), "utf8");
}

function sqlString(value) {
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
}

function sqlNumber(value) {
  return Number.isFinite(value) ? String(value) : "0";
}

function sqlNullableString(value) {
  return value === undefined || value === null || value === "" ? "NULL" : sqlString(value);
}

function notePosition(content) {
  const range = metaBlockRange(content);
  if (!range) return 1;
  return range.to + 1;
}

function roamDbSchemaStatements() {
  return [
    `CREATE TABLE IF NOT EXISTS files (
      path text primary key,
      mtime real not null,
      title text,
      node_id text,
      size integer not null default 0
    );`,
    `CREATE TABLE IF NOT EXISTS nodes (
      id text primary key,
      file text not null,
      title text not null,
      date text,
      position integer not null,
      summary text not null default ''
    );`,
    "CREATE TABLE IF NOT EXISTS tags (node_id text not null, tag text not null);",
    "CREATE TABLE IF NOT EXISTS aliases (node_id text not null, alias text not null);",
    "CREATE TABLE IF NOT EXISTS links (source_id text not null, target_id text not null, file text not null, line integer not null, label text);",
    "CREATE INDEX IF NOT EXISTS note_nodes_file_idx on nodes(file);",
    "CREATE INDEX IF NOT EXISTS note_tags_node_idx on tags(node_id);",
    "CREATE INDEX IF NOT EXISTS note_aliases_node_idx on aliases(node_id);",
    "CREATE INDEX IF NOT EXISTS note_links_target_idx on links(target_id);",
    "CREATE INDEX IF NOT EXISTS note_links_source_idx on links(source_id);",
  ];
}

async function appendRoamNodeStatements(statements, note, roamIds, refIndex, options = {}) {
  let info = null;
  let content = "";
  try {
    info = await stat(note.file);
    content = await readFile(note.file, "utf8");
  } catch {
    return;
  }
  if (options.includeNode !== false) {
    statements.push(
      `INSERT OR REPLACE INTO files(path, mtime, title, node_id, size) VALUES (${[
        sqlString(note.file),
        sqlNumber(info.mtimeMs / 1000),
        sqlString(note.title || ""),
        sqlString(note.id || ""),
        sqlNumber(info.size),
      ].join(", ")});`,
      `INSERT OR REPLACE INTO nodes(id, file, title, date, position, summary) VALUES (${[
        sqlString(note.id || ""),
        sqlString(note.file),
        sqlString(note.title || "Untitled"),
        sqlString(note.date || ""),
        sqlNumber(notePosition(content)),
        sqlString(note.summary || ""),
      ].join(", ")});`,
    );
    for (const tag of note.tags || []) {
      statements.push(`INSERT INTO tags(node_id, tag) VALUES (${sqlString(note.id)}, ${sqlString(tag)});`);
    }
    for (const alias of note.aliases || []) {
      statements.push(`INSERT INTO aliases(node_id, alias) VALUES (${sqlString(note.id)}, ${sqlString(alias)});`);
    }
  }
  for (const ref of [...new Set(roamDbRefsFromContent(content))]) {
    const target = refIndex.get(canonicalServerNoteRef(ref));
    const targetId = target?.id || "";
    if (!roamIds.has(targetId) || targetId === note.id) continue;
    statements.push(`INSERT INTO links(source_id, target_id, file, line, label) VALUES (${[
      sqlString(note.id),
      sqlString(targetId),
      sqlString(note.file),
      "1",
      sqlString(""),
    ].join(", ")});`);
  }
}

async function incrementalRoamDbStatements(scanned, changedFiles) {
  const files = [...new Set((changedFiles || []).map((file) => resolveUserPath(file)).filter((file) => inside(file, noteRoot)))];
  if (files.length === 0) return null;
  const fileKeySet = new Set(files.map(canonicalExistingPath));
  const noteFileChanged = (note) => Boolean(note.file && fileKeySet.has(canonicalExistingPath(note.file)));
  const changedNotes = scanned.filter(noteFileChanged);
  const changedIds = [...new Set(changedNotes.map((note) => note.id).filter(Boolean))];
  if (changedIds.length === 0) return null;
  const roamNotes = scanned.filter((note) => note.roam && note.file);
  const roamIds = new Set(roamNotes.map((note) => note.id));
  const refIndex = serverNoteReferenceIndex(roamNotes);
  const affectedSources = roamNotes.filter((note) =>
    noteFileChanged(note) || (note.refs || []).some((ref) => changedIds.includes(ref)));
  const linkRefreshFiles = [...new Set([...files, ...affectedSources.map((note) => note.file).filter(Boolean)])];
  const changedDbFiles = [...new Set([...files, ...changedNotes.map((note) => note.file).filter(Boolean)])];
  const statements = [
    "PRAGMA foreign_keys = OFF;",
    "BEGIN;",
    ...roamDbSchemaStatements(),
    `DELETE FROM links WHERE file IN (${linkRefreshFiles.map(sqlString).join(", ")}) OR source_id IN (${changedIds.map(sqlString).join(", ")}) OR target_id IN (${changedIds.map(sqlString).join(", ")});`,
    `DELETE FROM tags WHERE node_id IN (${changedIds.map(sqlString).join(", ")});`,
    `DELETE FROM aliases WHERE node_id IN (${changedIds.map(sqlString).join(", ")});`,
    `DELETE FROM nodes WHERE id IN (${changedIds.map(sqlString).join(", ")}) OR file IN (${changedDbFiles.map(sqlString).join(", ")});`,
    `DELETE FROM files WHERE path IN (${changedDbFiles.map(sqlString).join(", ")});`,
  ];
  for (const note of changedNotes.filter((note) => note.roam && note.file)) {
    await appendRoamNodeStatements(statements, note, roamIds, refIndex, { includeNode: true });
  }
  for (const note of affectedSources.filter((note) => !noteFileChanged(note))) {
    await appendRoamNodeStatements(statements, note, roamIds, refIndex, { includeNode: false });
  }
  statements.push("COMMIT;");
  return statements;
}

async function runFullRoamSync(scanned, dbFile) {
  const roamNotes = scanned.filter((note) => note.roam && note.file);
  const roamIds = new Set(roamNotes.map((note) => note.id));
  const refIndex = serverNoteReferenceIndex(roamNotes);
  const tmpDb = await runtimeTmpFile("db", dbFile, `.tmp-${process.pid}-${Date.now()}-${++atomicWriteCounter}`);
  const statements = [
    "PRAGMA foreign_keys = OFF;",
    "BEGIN;",
    ...roamDbSchemaStatements(),
    "DELETE FROM links;",
    "DELETE FROM tags;",
    "DELETE FROM aliases;",
    "DELETE FROM nodes;",
    "DELETE FROM files;",
  ];
  for (const note of roamNotes) {
    await appendRoamNodeStatements(statements, note, roamIds, refIndex, { includeNode: true });
  }
  statements.push("COMMIT;");
  await mkdir(dirname(dbFile), { recursive: true });
  try {
    await execFileAsync("sqlite3", [tmpDb, statements.join("\n")], {
      cwd: noteRoot,
      maxBuffer: 1024 * 1024 * 8,
    });
    try {
      await rename(tmpDb, dbFile);
    } catch (err) {
      if (err?.code !== "EXDEV") throw err;
      await copyFile(tmpDb, dbFile);
      await rm(tmpDb, { force: true }).catch(() => {});
    }
  } finally {
    await rm(tmpDb, { force: true }).catch(() => {});
  }
}

async function runIncrementalRoamSync(scanned, dbFile, changedFiles) {
  const statements = await incrementalRoamDbStatements(scanned, changedFiles);
  if (!statements) return false;
  await execFileAsync("sqlite3", [dbFile, statements.join("\n")], {
    cwd: noteRoot,
    maxBuffer: 1024 * 1024 * 8,
  });
  return true;
}

// options.mode: "auto" (default) | "full"
// options.changedFiles: string[] — caller-supplied explicit changed file list (skip git detection)
export async function syncRoamDb(notes = null, options = {}) {
  if (roamSyncTimer) {
    clearTimeout(roamSyncTimer);
    roamSyncTimer = null;
  }
  const queuedNotes = notes ? null : queuedRoamSyncNotes;
  const queuedFiles = [...queuedRoamSyncChangedFiles];
  queuedRoamSyncChangedFiles.clear();
  queuedRoamSyncNotes = null;
  const optionFiles = Array.isArray(options.changedFiles) ? options.changedFiles : [];
  const pendingFiles = [...new Set([...optionFiles, ...queuedFiles])];
  const scanned = notes ?? queuedNotes ?? await scanNotes();
  const previous = roamSyncInFlight ?? Promise.resolve();
  const current = previous.catch(() => {}).then(async () => {
    const dbFile = roamDbFile();
    const forceMode = options.mode === "full";
    const explicitFiles = pendingFiles.length > 0 ? pendingFiles : null;

    const state = await readSyncState();
    const schemaOk = state.dbSchemaVersion === CURRENT_DB_SCHEMA;
    const dbExists = existsSync(dbFile);
    const now = new Date().toISOString();

    // Determine whether we must do a full rebuild.
    // Use a deterministic time-based policy instead of random sampling so the
    // save path has predictable latency.  Weekly rebuild provides self-healing.
    const stale = state.lastFullAt
      ? (Date.now() - new Date(state.lastFullAt).getTime()) > ROAM_FULL_SYNC_INTERVAL_MS
      : false;
    const needFull = forceMode || !dbExists || !schemaOk || !state.lastSyncedCommit || stale;

    if (needFull) {
      const reason = forceMode ? "forced" : !dbExists ? "no-db" : !schemaOk ? "schema" : !state.lastSyncedCommit ? "no-state" : "stale";
      console.log(`[roam-sync] full rebuild (${reason})`);
      await runFullRoamSync(scanned, dbFile);
      const sha = await commitRoam(noteRoot, `roam sync: ${now}`);
      await writeSyncState({ lastSyncedCommit: sha, lastSyncedAt: now, lastFullAt: now, dbSchemaVersion: CURRENT_DB_SCHEMA });
      return;
    }

    // Resolve changed files: explicit > git detection
    let changedFiles = explicitFiles;
    if (!changedFiles) {
      changedFiles = await changedRoamFilesSince(noteRoot, state.lastSyncedCommit);
      if (changedFiles === null) {
        // commit no longer reachable (rebase/squash) — fallback to full
        console.log("[roam-sync] full rebuild (stale commit ref)");
        await runFullRoamSync(scanned, dbFile);
        const sha = await commitRoam(noteRoot, `roam sync: ${now}`);
        await writeSyncState({ lastSyncedCommit: sha, lastSyncedAt: now, lastFullAt: state.lastFullAt, dbSchemaVersion: CURRENT_DB_SCHEMA });
        return;
      }
    }

    if (changedFiles.length === 0) {
      console.log("[roam-sync] incremental: no changes detected");
      return;
    }

    console.log(`[roam-sync] incremental: ${changedFiles.length} file(s)`);
    const roamOk = await runIncrementalRoamSync(scanned, dbFile, changedFiles);
    if (!roamOk) {
      // Incremental builder found no indexable note changes.
      return;
    }
    const sha = await commitRoam(noteRoot, `roam sync: ${now}`);
    await writeSyncState({ lastSyncedCommit: sha, lastSyncedAt: now, lastFullAt: state.lastFullAt, dbSchemaVersion: CURRENT_DB_SCHEMA });
  });
  roamSyncInFlight = current;
  try {
    await current;
  } finally {
    if (roamSyncInFlight === current) roamSyncInFlight = null;
  }
  return scanned;
}

// Exported for desktop/main.mjs weekly full-sync check
export async function maybeScheduleWeeklyFullSync() {
  const state = await readSyncState();
  if (!state.lastFullAt) return false; // no state yet — first full sync will happen on next manual sync
  const age = Date.now() - new Date(state.lastFullAt).getTime();
  if (age < 7 * 24 * 60 * 60 * 1000) return false;
  console.log("[roam-sync] weekly full rebuild triggered");
  void syncRoamDb(null, { mode: "full" }).catch((err) => {
    console.error("[roam-sync] weekly full rebuild failed:", err?.message || err);
  });
  return true;
}

// Exported for version control features
export {
  bibliographyCompletions,
  bibliographyForDocument,
  bibliographyPathWatchRelevant,
  bibliographyVersion,
  clearBibliographyCache,
  fileHistory,
  restoreFileFromCommit,
  discardFileChanges,
  roamRepoStatus,
  roamRepoChanges,
  diffRoamFile,
  diffRoamCommit,
  pullRoam,
  pushRoam,
  repoHistory,
  noteRoot as roamNoteRoot,
};

export async function createNode(body) {
  const title = String(body.title || "Untitled").trim() || "Untitled";
  const nodeType = String(body.nodeType || body.type || "roam").toLowerCase() === "regular" ? "regular" : "roam";
  const roam = nodeType === "roam";
  const id = String(body.id || `${timestampId()}-${slugifyTitle(title)}`).trim();
  const kind = normalizeNoteKind(body.kind || (roam ? "note" : defaultNoteKind));
  const tags = Array.isArray(body.tags) ? body.tags.map(String).filter(Boolean) : [];
  const rawPath = String(body.path || body.file || "").trim();
  const directory = String(body.directory || ".").trim() || ".";
  const defaultName = `${slugifyTitle(roam ? id : title)}.md`;
  let relativePath = rawPath
    ? rawPath
    : join(directory, defaultName);
  if (relativePath.endsWith("/") || relativePath.endsWith(sep)) {
    relativePath = join(relativePath, defaultName);
  } else if (!extname(relativePath)) {
    relativePath = `${relativePath}.md`;
  }
  const baseRoot = roam ? noteRoot : noteScanRoot;
  const file = resolveInputPath(relativePath, baseRoot);
  if (!inside(file, baseRoot) || (roam && !inside(file, noteRoot))) {
    const err = new Error(`File is outside note root: ${file}`);
    err.statusCode = 403;
    throw err;
  }
  if (!/\.(?:md|markdown)$/i.test(file)) {
    const err = new Error("New notes must use .md or .markdown");
    err.statusCode = 400;
    throw err;
  }
  const dir = dirname(file);
  await mkdir(dir, { recursive: true });
  if (existsSync(file)) {
    const err = new Error(`Node already exists: ${file}`);
    err.statusCode = 409;
    throw err;
  }
  let selection = null;
  let content = "";
  const template = await templateByKey(body.templateKey || body.template || "");
  if (template) {
    const relPath = displayPathForScanRoot(file, noteScanRoot);
    const expanded = expandTemplateBody(template.body, templateVarsForNode({
      title,
      id,
      tags,
      kind,
      path: relPath,
    }));
    content = expanded.text.replace(/\s+$/, "") + "\n";
    selection = expanded.selection;
    if (!hasNoteMetadata(content)) {
      const meta = buildMetaBlock({
        id: roam ? id : "",
        title,
        date: new Date().toISOString().slice(0, 10),
        kind,
        roam: roam ? "" : "off",
        tags,
        refs: [],
      }, { includeSummary: true });
      const prefix = `${meta}\n`;
      const offset = prefix.length;
      content = `${prefix}${content.replace(/^\s+/, "")}`;
      if (selection) selection = { from: selection.from + offset, to: selection.to + offset };
    } else {
      const summarized = withMetaSummary(content);
      content = summarized.content;
      if (selection && summarized.offset) {
        selection = { from: selection.from + summarized.offset, to: selection.to + summarized.offset };
      }
      if (!roam) {
        // Regular note from a template that already carries its own meta block:
        // ensure it is excluded from the roam graph.
        const { content: next, offset } = withMetaRoamOff(content);
        content = next;
        if (selection && offset) selection = { from: selection.from + offset, to: selection.to + offset };
      }
    }
  } else {
    content = [
      buildMetaBlock({
        id: roam ? id : "",
        title,
        date: new Date().toISOString().slice(0, 10),
        kind,
        roam: roam ? "" : "off",
        tags,
        refs: [],
      }, { includeSummary: true }),
      `# ${title}`,
      "",
    ].join("\n");
  }
  await writeFile(file, content, "utf8");
  markNotesDirty(file);
  const opened = await readNote(file, { includeIndex: true });
  if (selection) opened.selection = selection;
  if (roam) queueRoamDbSync(opened.notes, [file]);
  return opened;
}

export async function createFolder(body) {
  const rawPath = String(body.path || body.dir || body.folder || "").trim();
  if (!rawPath) {
    const err = new Error("Missing folder path");
    err.statusCode = 400;
    throw err;
  }
  const dir = resolveInputPath(rawPath, noteScanRoot);
  if (!inside(dir, noteScanRoot)) {
    const err = new Error(`Folder is outside note root: ${dir}`);
    err.statusCode = 403;
    throw err;
  }
  await mkdir(dir, { recursive: true });
  markNotesDirty();
  const index = await notesIndexPayload();
  return {
    ok: true,
    path: displayPathForScanRoot(dir, noteScanRoot) || "Root",
    ...index,
  };
}

async function uniqueTrashPath(file) {
  const trashDir = join(homedir(), ".Trash");
  await mkdir(trashDir, { recursive: true });
  const ext = extname(file);
  const stem = basename(file, ext) || "note";
  let target = join(trashDir, basename(file));
  for (let i = 2; existsSync(target); i++) {
    target = join(trashDir, `${stem}-${i}${ext}`);
  }
  return target;
}

async function moveToTrash(file) {
  if (process.platform === "darwin") {
    try {
      await execFileAsync("osascript", [
        "-e",
        `tell application "Finder" to delete POSIX file ${JSON.stringify(file)}`,
      ]);
      return "system-trash";
    } catch {}
  }
  const target = await uniqueTrashPath(file);
  await rename(file, target);
  return target;
}

export function queueRoamDbSync(notes = null, changedFiles = []) {
  if (notes) queuedRoamSyncNotes = notes;
  const files = Array.isArray(changedFiles) ? changedFiles : [changedFiles];
  for (const file of files) {
    if (!file) continue;
    // Set dedupe keeps a burst of external changes (e.g. a git checkout of many
    // notes) from accumulating in O(n^2) via repeated Array.includes scans.
    queuedRoamSyncChangedFiles.add(resolveUserPath(file));
  }
  if (roamSyncTimer) {
    clearTimeout(roamSyncTimer);
    roamSyncTimer = null;
  }
}

export function runtimeDebugSnapshot() {
  return {
    roamDbSync: {
      queued: Boolean(queuedRoamSyncNotes) || queuedRoamSyncChangedFiles.size > 0,
      changedFiles: queuedRoamSyncChangedFiles.size,
      inFlight: Boolean(roamSyncInFlight),
    },
    paths: {
      stateRoot,
      tmpRoot: runtimeTmpRoot || aaronnoteTmpRoot(),
    },
    saveWrites: {
      queuedFiles: saveWriteQueues.size,
    },
    copilot: {
      started: Boolean(copilotClient),
      busy: Boolean(copilotClient?.status?.busy),
      status: copilotClient?.status?.message || "Not started",
    },
  };
}

// Historical name kept for existing call sites. Writes only accumulate changed
// files here; explicit/manual sync and the very-low-rate save sampler below are
// the only paths that drain the queue.
function scheduleRoamDbSync(notes, changedFile) {
  queueRoamDbSync(notes, changedFile ? [changedFile] : []);
}

export function saveSamplesRoamDbSync(sample = Math.random()) {
  return Number.isFinite(sample) && sample >= 0 && sample < ROAM_SAVE_SYNC_SAMPLE_RATE;
}

function maybeSyncRoamDbAfterSave() {
  if (!saveSamplesRoamDbSync()) return;
  // syncRoamDb atomically drains the queued Set and serializes with an existing
  // sync.  Do not await it: the rare maintenance branch must not add latency to
  // the save response.
  void syncRoamDb().catch((err) => {
    console.error("[roam-sync] sampled save sync failed:", err?.message || err);
  });
}

export async function deleteNote(body) {
  const file = safeOpenFile(body.file);
  noteScanRoot = scanRootForOpenFile(file);
  let trashedTo = "";
  let info = null;
  try {
    info = await stat(file);
  } catch {}
  try {
    trashedTo = await moveToTrash(file);
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }
  markNotesDirty(file);
  const index = await notesIndexPayload();
  if (!standaloneFile(file)) queueRoamDbSync(index.notes, [file]);
  return { type: "deleted", ok: true, file, trashedTo, ...index };
}

function safeManagedPath(input) {
  const raw = String(input || "").trim();
  if (!raw) {
    const err = new Error("Missing path");
    err.statusCode = 400;
    throw err;
  }
  const file = resolveInputPath(raw, noteScanRoot);
  if (!inside(file, noteScanRoot)) {
    const err = new Error(`Path is outside note root: ${file}`);
    err.statusCode = 403;
    throw err;
  }
  return file;
}

async function managedPathInfo(input) {
  const file = safeManagedPath(input);
  const info = await stat(file);
  return { file, info };
}

function targetPathForRename(file, name) {
  const clean = sanitizeAssetName(name, basename(file));
  if (!clean) {
    const err = new Error("Missing new name");
    err.statusCode = 400;
    throw err;
  }
  return resolve(dirname(file), clean);
}

function targetPathForMove(file, body) {
  if (body.target || body.to || body.pathTo) return safeManagedPath(body.target || body.to || body.pathTo);
  const rawDir = String(body.directory || body.dir || "").trim();
  if (!rawDir) {
    const err = new Error("Missing target directory");
    err.statusCode = 400;
    throw err;
  }
  const dir = safeManagedPath(rawDir);
  return resolve(dir, basename(file));
}

async function assertMoveTargetParent(target) {
  let info = null;
  try {
    info = await stat(dirname(target));
  } catch {
    const err = new Error(`Target folder does not exist: ${dirname(target)}`);
    err.statusCode = 400;
    throw err;
  }
  if (!info.isDirectory()) {
    const err = new Error(`Target parent is not a folder: ${dirname(target)}`);
    err.statusCode = 400;
    throw err;
  }
}

function assertTargetWritable(source, target) {
  if (!inside(target, noteScanRoot)) {
    const err = new Error(`Target is outside note root: ${target}`);
    err.statusCode = 403;
    throw err;
  }
  if (target === source) {
    const err = new Error("Source and target are the same");
    err.statusCode = 400;
    throw err;
  }
  if (existsSync(target)) {
    const err = new Error(`Target already exists: ${target}`);
    err.statusCode = 409;
    throw err;
  }
}

async function fsPayload(extra = {}) {
  const index = await notesIndexPayload();
  return { ok: true, ...extra, ...index };
}

export async function renameManagedPath(body) {
  const { file, info } = await managedPathInfo(body.path || body.file);
  if (file === noteScanRoot) {
    const err = new Error("Cannot rename the root folder");
    err.statusCode = 400;
    throw err;
  }
  const target = targetPathForRename(file, body.name || body.targetName);
  assertTargetWritable(file, target);
  await rename(file, target);
  noteSelfWrite(file); noteSelfWrite(target);
  await renameManagedLeanMirror(file, target, info);
  markNotesDirty();
  return fsPayload({
    type: "fs-renamed",
    file: target,
    oldFile: file,
    path: displayPathForScanRoot(target, noteScanRoot) || "Root",
    oldPath: displayPathForScanRoot(file, noteScanRoot) || "Root",
  });
}

export async function moveManagedPath(body) {
  const { file, info } = await managedPathInfo(body.path || body.file);
  if (file === noteScanRoot) {
    const err = new Error("Cannot move the root folder");
    err.statusCode = 400;
    throw err;
  }
  const target = targetPathForMove(file, body);
  if (info.isDirectory() && inside(target, file)) {
    const err = new Error("Cannot move a folder into itself");
    err.statusCode = 400;
    throw err;
  }
  assertTargetWritable(file, target);
  await assertMoveTargetParent(target);
  await rename(file, target);
  noteSelfWrite(file); noteSelfWrite(target);
  await renameManagedLeanMirror(file, target, info);
  markNotesDirty();
  return fsPayload({
    type: "fs-moved",
    file: target,
    oldFile: file,
    path: displayPathForScanRoot(target, noteScanRoot) || "Root",
    oldPath: displayPathForScanRoot(file, noteScanRoot) || "Root",
  });
}

function duplicatePathFor(file, requested = "") {
  if (requested) return safeManagedPath(requested);
  const ext = extname(file);
  const stem = basename(file, ext);
  for (let i = 1; i < 10_000; i++) {
    const suffix = i === 1 ? " copy" : ` copy ${i}`;
    const target = resolve(dirname(file), `${stem}${suffix}${ext}`);
    if (!existsSync(target)) return target;
  }
  const err = new Error("Could not find a duplicate path");
  err.statusCode = 409;
  throw err;
}

export async function duplicateManagedFile(body) {
  const { file, info } = await managedPathInfo(body.path || body.file);
  if (!info.isFile()) {
    const err = new Error("Only files can be duplicated");
    err.statusCode = 400;
    throw err;
  }
  const target = duplicatePathFor(file, body.target || body.to || "");
  assertTargetWritable(file, target);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(file, target);
  await copyManagedLeanMirror(file, target, info);
  markNotesDirty(target);
  return fsPayload({
    type: "fs-duplicated",
    file: target,
    oldFile: file,
    path: displayPathForScanRoot(target, noteScanRoot),
    oldPath: displayPathForScanRoot(file, noteScanRoot),
  });
}

async function directoryHasEntries(dir) {
  try {
    const entries = await readdir(dir);
    return entries.some((entry) => entry !== ".aaronnote-keep");
  } catch {
    return false;
  }
}

export async function trashManagedPath(body) {
  const file = safeManagedPath(body.path || body.file);
  let info;
  try {
    info = await stat(file);
  } catch (err) {
    if (err?.code === "ENOENT") {
      await deleteManagedLeanMirror(file, null);
      markNotesDirty();
      return fsPayload({
        type: "fs-missing",
        file,
        path: displayPathForScanRoot(file, noteScanRoot) || "Root",
      });
    }
    throw err;
  }
  if (file === noteScanRoot) {
    const err = new Error("Cannot trash the root folder");
    err.statusCode = 400;
    throw err;
  }
  if (info.isDirectory() && await directoryHasEntries(file) && body.confirm !== "TRASH") {
    const err = new Error("Type TRASH to move a non-empty folder to Trash");
    err.statusCode = 400;
    throw err;
  }
  const trashedTo = await moveToTrash(file);
  markNotesDirty();
  return fsPayload({
    type: "fs-trashed",
    file,
    trashedTo,
    path: displayPathForScanRoot(file, noteScanRoot) || "Root",
  });
}

export async function updateCurrentNoteMeta(body, action) {
  const file = safeFile(body.file);
  const content = typeof body.content === "string" ? body.content : await readFile(file, "utf8");
  let next = content;
  if (action === "remove") {
    next = removeMetaBlock(content);
  } else if (action === "tag") {
    const currentTags = tagsFromContent(content);
    const incoming = Array.isArray(body.tags) ? body.tags : parseListValue(body.tags || "");
    next = upsertMetaBlock(file, content, { tags: normalizeTags([...currentTags, ...incoming]) });
  } else if (action === "hide-roam") {
    next = upsertMetaBlock(file, content, { roam: "off" });
  } else if (action === "activate-roam") {
    next = upsertMetaBlock(file, content, { roam: "" });
  } else {
    const patch = {
      title: body.title,
      tags: body.tags || tagsFromContent(content),
      kind: body.kind || defaultNoteKind,
    };
    if (Object.prototype.hasOwnProperty.call(body || {}, "project")) patch.project = body.project;
    next = upsertMetaBlock(file, content, patch);
  }
  if (next !== content) {
    await atomicWriteFile(file, next, "utf8");
    markNotesDirty(file);
  }
  const opened = await readNote(file, { includeIndex: true });
  if (next !== content) queueRoamDbSync(opened.notes, [file]);
  return opened;
}

async function rewriteRoamMetaTags(updateTags) {
  const scanned = await scanNotes();
  const changedFiles = [];
  const changed = [];
  for (const note of scanned.filter((item) => item.roam && item.file)) {
    let content = "";
    try {
      content = await readFile(note.file, "utf8");
    } catch {
      continue;
    }
    const before = tagsFromContent(content);
    const after = normalizeTags(updateTags(before));
    if (sameStringList(before, after)) continue;
    const next = upsertMetaBlock(note.file, content, { tags: after });
    if (next === content) continue;
    await atomicWriteFile(note.file, next, "utf8");
    markNotesDirty(note.file);
    changedFiles.push(note.file);
    changed.push({ file: note.file, path: note.path || "", title: note.title || "", tags: after });
  }
  const index = await notesIndexPayload();
  if (changedFiles.length > 0) queueRoamDbSync(index.notes, changedFiles);
  return { ok: true, changed, changedCount: changed.length, ...index };
}

export async function renameRoamTag(body) {
  const from = String(body.from || body.old || "").trim().replace(/^#/, "");
  const to = String(body.to || body.next || "").trim().replace(/^#/, "");
  if (!from || !to) {
    const err = new Error("Missing tag rename values");
    err.statusCode = 400;
    throw err;
  }
  return rewriteRoamMetaTags((tags) => tags.map((tag) => tag.toLowerCase() === from.toLowerCase() ? to : tag));
}

export async function deleteRoamTag(body) {
  const tag = String(body.tag || body.name || "").trim().replace(/^#/, "");
  if (!tag) {
    const err = new Error("Missing tag");
    err.statusCode = 400;
    throw err;
  }
  return rewriteRoamMetaTags((tags) => tags.filter((item) => item.toLowerCase() !== tag.toLowerCase()));
}

export async function roamTagOverlapReport() {
  const scanned = await scanNotes();
  const byTag = new Map();
  const variants = new Map();
  for (const note of scanned.filter((item) => item.roam)) {
    const key = graphNoteKey(note);
    if (!key) continue;
    for (const tag of note.tags || []) {
      const clean = String(tag || "").trim().replace(/^#/, "");
      if (!clean) continue;
      const lower = clean.toLowerCase();
      if (!byTag.has(lower)) byTag.set(lower, { name: clean, lower, notes: new Map() });
      byTag.get(lower).notes.set(key, { key, id: note.id || "", title: note.title || "", path: note.path || "" });
      if (!variants.has(lower)) variants.set(lower, new Set());
      variants.get(lower).add(clean);
    }
  }
  const duplicateCase = [...variants.entries()]
    .map(([lower, names]) => ({ lower, variants: [...names].sort((a, b) => a.localeCompare(b)) }))
    .filter((item) => item.variants.length > 1);
  const entries = [...byTag.values()].filter((entry) => entry.notes.size >= 2);
  const overlaps = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i];
      const b = entries[j];
      const aKeys = new Set(a.notes.keys());
      const bKeys = new Set(b.notes.keys());
      const sharedKeys = [...aKeys].filter((key) => bKeys.has(key));
      if (sharedKeys.length < 2) continue;
      const containment = sharedKeys.length / Math.min(aKeys.size, bKeys.size);
      const jaccard = sharedKeys.length / new Set([...aKeys, ...bKeys]).size;
      if (containment < 0.8 && jaccard < 0.65) continue;
      overlaps.push({
        a: a.name,
        b: b.name,
        aCount: aKeys.size,
        bCount: bKeys.size,
        sharedCount: sharedKeys.length,
        containment,
        jaccard,
        notes: sharedKeys.slice(0, 8).map((key) => a.notes.get(key)),
      });
    }
  }
  overlaps.sort((a, b) =>
    b.containment - a.containment
    || b.sharedCount - a.sharedCount
    || `${a.a}/${a.b}`.localeCompare(`${b.a}/${b.b}`));
  return {
    ok: true,
    duplicateCase,
    overlaps: overlaps.slice(0, 80),
    tagCount: byTag.size,
  };
}

function notePathWithoutRoamPrefix(path) {
  return normalizeNoteRefPath(path).replace(/^roam\//i, "");
}

function notePathKeyVariants(path) {
  const clean = normalizeNoteRefPath(path);
  const noRoam = notePathWithoutRoamPrefix(clean);
  return new Set([
    canonicalServerNoteRef(clean),
    canonicalServerNoteRef(noRoam),
    canonicalServerNoteRef(`roam/${noRoam}`),
  ].filter(Boolean));
}

function relativeNotePath(fromDir, toPath) {
  const fromParts = fromDir && fromDir !== "Root" ? directoryPathParts(fromDir) : [];
  const toParts = directoryPathParts(toPath);
  let shared = 0;
  while (shared < fromParts.length && shared < toParts.length && fromParts[shared] === toParts[shared]) shared++;
  const parts = [
    ...Array.from({ length: fromParts.length - shared }, () => ".."),
    ...toParts.slice(shared),
  ];
  return parts.join("/") || toParts.at(-1) || "";
}

function hrefPathSuffixIndex(href) {
  const raw = String(href || "");
  const indexes = ["?", "#"]
    .map((token) => raw.indexOf(token))
    .filter((index) => index >= 0);
  const at = raw.lastIndexOf("@");
  if (at > raw.lastIndexOf("/") && /\.(?:md|markdown|typ)$/i.test(raw.slice(0, at))) indexes.push(at);
  return indexes.length > 0 ? Math.min(...indexes) : raw.length;
}

function markdownHrefMatch(href, note, oldKeys) {
  const protocol = hrefProtocol(href);
  if (protocol && protocol !== "file") return null;
  let path = noteFileRefFromHref(href);
  if (!path) return null;
  const sourceDir = directoryParentPath(note.path || "");
  const direct = notePathKeyVariants(path);
  if ([...direct].some((key) => oldKeys.has(key))) return { sourceDir, relative: false };
  if (path.startsWith("/")) {
    const resolved = resolveUserPath(path);
    if (inside(resolved, noteRoot)) {
      const rel = slashPath(relativeCanonical(noteRoot, resolved));
      if ([...notePathKeyVariants(rel)].some((key) => oldKeys.has(key))) return { sourceDir, relative: false };
    }
    return null;
  }
  if (!/^roam\//i.test(path)) {
    const fromSource = normalizeNoteRefPath(`${sourceDir === "Root" ? "" : sourceDir}/${path}`);
    if ([...notePathKeyVariants(fromSource)].some((key) => oldKeys.has(key))) return { sourceDir, relative: true };
  }
  return null;
}

function replacementHrefPath(href, match, newPath) {
  const raw = String(href || "");
  const pathEnd = hrefPathSuffixIndex(raw);
  const oldPath = raw.slice(0, pathEnd);
  const suffix = raw.slice(pathEnd);
  const nextRootPath = notePathWithoutRoamPrefix(newPath);
  let nextPath = nextRootPath;
  if (/^roam\//i.test(oldPath)) nextPath = `roam/${nextRootPath}`;
  else if (oldPath.startsWith("/")) nextPath = `/${nextRootPath}`;
  else if (oldPath.startsWith(".") || match.relative) nextPath = relativeNotePath(match.sourceDir, nextRootPath);
  return `${nextPath.replace(/ /g, "%20")}${suffix}`;
}

function rewriteMarkdownPathRefsInContent(content, note, oldPath, newPath) {
  const oldKeys = notePathKeyVariants(oldPath);
  const destinations = markdownLinkDestinations(content)
    .map((dest) => ({ dest, match: markdownHrefMatch(dest.href, note, oldKeys) }))
    .filter((item) => item.match);
  if (destinations.length === 0) return { content, count: 0 };
  let next = content;
  for (const { dest, match } of destinations.reverse()) {
    const href = replacementHrefPath(dest.href, match, newPath);
    next = `${next.slice(0, dest.hrefFrom)}${href}${next.slice(dest.hrefTo)}`;
  }
  return { content: next, count: destinations.length };
}

export async function rewriteMarkdownPathReferences(body) {
  const oldPath = String(body.oldPath || body.from || "").trim();
  const newPath = String(body.newPath || body.to || "").trim();
  if (!oldPath || !newPath) {
    const err = new Error("Missing path rewrite values");
    err.statusCode = 400;
    throw err;
  }
  const dryRun = body.dryRun === true;
  const scanned = await scanNotes();
  const changedFiles = [];
  const changed = [];
  for (const note of scanned.filter((item) => item.file)) {
    let content = "";
    try {
      content = await readFile(note.file, "utf8");
    } catch {
      continue;
    }
    const result = rewriteMarkdownPathRefsInContent(content, note, oldPath, newPath);
    if (result.count === 0 || result.content === content) continue;
    if (!dryRun) {
      await atomicWriteFile(note.file, result.content, "utf8");
      markNotesDirty(note.file);
      changedFiles.push(note.file);
    }
    changed.push({ file: note.file, path: note.path || "", title: note.title || "", count: result.count });
  }
  const index = dryRun ? await notesIndexPayload(scanned) : await notesIndexPayload();
  if (!dryRun && changedFiles.length > 0) queueRoamDbSync(index.notes, changedFiles);
  return { ok: true, dryRun, changed, changedCount: changed.length, referenceCount: changed.reduce((sum, item) => sum + item.count, 0), ...index };
}

function acceptSaveRequest(file, body) {
  const clientId = typeof body.clientId === "string" ? body.clientId : "";
  const seq = Number(body.seq);
  if (!clientId || !Number.isSafeInteger(seq) || seq <= 0) return true;
  const key = `${clientId}\0${file}`;
  const previous = saveRequestVersions.get(key) ?? 0;
  if (seq < previous) return false;
  saveRequestVersions.set(key, seq);
  if (saveRequestVersions.size > 2000) {
    for (const oldKey of saveRequestVersions.keys()) {
      saveRequestVersions.delete(oldKey);
      if (saveRequestVersions.size <= 1000) break;
    }
  }
  return true;
}

async function enqueueSaveWrite(file, task) {
  const key = canonicalExistingPath(file);
  const previous = saveWriteQueues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  saveWriteQueues.set(key, current);
  try {
    return await current;
  } finally {
    if (saveWriteQueues.get(key) === current) saveWriteQueues.delete(key);
  }
}

export function configure(options = {}) {
  noteRoot = resolveUserPath(options.root || process.env.AARONNOTE_ROOT || join(appDir, "..", "roam"));
  noteScanRoot = noteRoot;
  workspaceRoot = resolve(String(options.workspaceRoot || process.env.AARONNOTE_WORKSPACE_ROOT || resolve(appDir, "..")));
  publishJsDir = resolve(String(options.publishJsDir || process.env.AARONNOTE_PUBLISH_JS_DIR || join(workspaceRoot, "js")));
  stateRoot = resolve(String(options.stateRoot || process.env.AARONNOTE_STATE_DIR || join(workspaceRoot, "var", "aaronnote")));
  sessionManager = null;
  runtimeTmpRoot = configureTmpRoot(options.tmpRoot || process.env.AARONNOTE_TMP_DIR || join(stateRoot, "tmp"));
  snippetsRoot = resolve(String(options.snippetsRoot || process.env.AARONNOTE_SNIPPETS_ROOT || join(workspaceRoot, "snippets")));
  templatesRoot = resolve(String(options.templatesRoot || process.env.AARONNOTE_TEMPLATES_ROOT || join(workspaceRoot, "templates", "noema")));
  latexTemplatesRoot = resolve(String(options.latexTemplatesRoot || process.env.AARONNOTE_LATEX_TEMPLATES_ROOT || join(workspaceRoot, "templates")));
  katexMacrosRoot = resolve(String(options.katexMacrosRoot || process.env.AARONNOTE_KATEX_MACROS_DIR || join(workspaceRoot, "etc", "katex-macros")));
  latexAgentDir = resolve(String(options.latexAgentDir || process.env.AARONNOTE_LATEX_AGENT_DIR || join(appDir, "agents", "latex-export")));
  latexExportEngine = String(options.latexExportEngine || process.env.AARONNOTE_LATEX_EXPORT_ENGINE || "codex").trim().toLowerCase();
  latexExportAgent = String(options.latexExportAgent || process.env.AARONNOTE_LATEX_EXPORT_AGENT || "codex").trim().toLowerCase();
  latexCodexBin = String(options.latexCodexBin || process.env.AARONNOTE_CODEX_BIN || "codex").trim();
  latexClaudeBin = String(options.latexClaudeBin || process.env.AARONNOTE_CLAUDE_BIN || "claude").trim();
  latexOpencodeBin = String(options.latexOpencodeBin || process.env.AARONNOTE_OPENCODE_BIN || "opencode").trim();
  latexCodexModel = String(options.latexCodexModel || process.env.AARONNOTE_CODEX_MODEL || "").trim();
  latexExportModel = String(options.latexExportModel || process.env.AARONNOTE_LATEX_EXPORT_MODEL || "").trim();
  latexExportMaxAttempts = Math.max(1, Number(options.latexExportMaxAttempts || process.env.AARONNOTE_LATEX_EXPORT_MAX_ATTEMPTS) || 3);
  latexExportAgentIdleTimeoutMs = Math.max(10_000, Number(options.latexExportAgentIdleTimeoutMs || process.env.AARONNOTE_LATEX_EXPORT_AGENT_IDLE_TIMEOUT_MS) || 180_000);
  latexExportAgentHardTimeoutMs = Math.max(latexExportAgentIdleTimeoutMs, Number(options.latexExportAgentHardTimeoutMs || process.env.AARONNOTE_LATEX_EXPORT_AGENT_HARD_TIMEOUT_MS) || 900_000);
  configureBibliography({ root: noteRoot });
  snippetCache = { key: "", scannedAt: 0, snippets: [] };
  templateCache = { key: "", scannedAt: 0, templates: [] };
  contentRootCache.clear();
  noteCodeFileCache.clear();
  noteCodeFilePending.clear();
  noteCodeFileCacheBytes = 0;
  reservedPlanningIds.clear();
  planningIdCache = { version: -1, ids: null };
  planningIdFallbackCounter = 0;
  if (roamSyncTimer) {
    clearTimeout(roamSyncTimer);
    roamSyncTimer = null;
  }
  roamSyncInFlight = null;
  queuedRoamSyncNotes = null;
  queuedRoamSyncChangedFiles = new Set();
  agendaPersistentCache = null;
  agendaPersistentCacheKey = "";
  agendaPersistentCacheDirty = false;
  agendaPersistentCacheLoad = null;
  notesSnapshotFingerprint = "";
  markNotesDirty();
}

export function configureExternalFileProvider(provider = null) {
  externalFileProvider = provider && typeof provider === "object"
    ? provider
    : null;
}

export async function saveNote(body) {
  if (externalFileProvider?.owns?.(body?.file)) {
    const file = String(body.file);
    const content = String(body.content ?? "");
    if (!acceptSaveRequest(file, body)) {
      return {
        type: "saved", ok: true, file, stale: true,
        message: "Skipped stale save",
      };
    }
    const wrote = await enqueueSaveWrite(
      file,
      () => externalFileProvider.write({
        file,
        content,
        force: body.force === true,
        baseMtimeMs: Number(body.baseMtimeMs) || 0,
      }),
    );
    if (wrote?.conflict || wrote?.ok === false) {
      return {
        type: "saved",
        ok: false,
        file,
        conflict: wrote?.conflict === true,
        message: String(wrote?.message || "Remote save failed"),
        mtimeMs: Number(wrote?.mtimeMs) || 0,
        size: Number(wrote?.size) || 0,
        standalone: true,
      };
    }
    return {
      type: "saved",
      ok: true,
      file: String(wrote?.file || file),
      kind: kindFromContent(content),
      message: "Saved",
      notesRefresh: "deferred",
      standalone: true,
      remote: true,
      mtimeMs: Number(wrote?.mtimeMs) || 0,
      size: Number(wrote?.size) || Buffer.byteLength(content, "utf8"),
    };
  }
  const file = safeOpenFile(body.file);
  const content = String(body.content ?? "");
  const previousContent = await readFile(file, "utf8").catch(() => "");
  if (body.force !== true && content.trim() === "" && previousContent.trim() !== "") {
    return {
      type: "saved", ok: false, file,
      message: "Refusing to save empty content over a non-empty file. Use force: true to override.",
    };
  }
  const force = body.force === true;
  const baseMtimeMs = Number(body.baseMtimeMs);
  const wrote = await enqueueSaveWrite(file, async () => {
    if (!acceptSaveRequest(file, body)) return false;
    if (!force && Number.isFinite(baseMtimeMs) && baseMtimeMs > 0) {
      try {
        const current = await stat(file);
        if (Math.abs(current.mtimeMs - baseMtimeMs) > 1) {
          return { conflict: true, mtimeMs: current.mtimeMs, size: current.size };
        }
      } catch {}
    }
    await atomicWriteFile(file, content, "utf8");
    const info = await stat(file);
    markNotesDirty(file);
    return { wrote: true, mtimeMs: info.mtimeMs, size: info.size };
  });
  if (wrote && typeof wrote === "object" && wrote.conflict) {
    return { type: "saved", ok: false, file, conflict: true, message: "File changed on disk. Review before overwriting.", mtimeMs: wrote.mtimeMs, size: wrote.size };
  }
  if (!wrote) {
    return { type: "saved", ok: true, file, stale: true, message: "Skipped stale save" };
  }
  if (standaloneFile(file)) {
    noteScanRoot = scanRootForOpenFile(file);
    markNotesDirty(file);
    return { type: "saved", ok: true, file, kind: kindFromContent(content), message: "Saved", note: await noteSummaryForFile(file, content), notesRefresh: "deferred", standalone: true, mtimeMs: wrote.mtimeMs, size: wrote.size };
  }
  const refresh = body.refresh === "deferred" ? "deferred" : "full";
  if (refresh === "deferred") {
    markNotesDirty(file);
    scheduleRoamDbSync(null, file);
    maybeSyncRoamDbAfterSave();
    return { type: "saved", ok: true, file, message: "Saved", note: await noteSummaryForFile(file, content), kind: kindFromContent(content), notesRefresh: "deferred", standalone: false, mtimeMs: wrote.mtimeMs, size: wrote.size };
  }
  const notes = await scanNotes();
  scheduleRoamDbSync(notes, file);
  maybeSyncRoamDbAfterSave();
  return { type: "saved", ok: true, file, message: "Saved", notes, notesRefresh: "full", standalone: false, mtimeMs: wrote.mtimeMs, size: wrote.size };
}

export async function bootstrapNote(file) {
  if (file) {
    return readNote(file, { includeIndex: true });
  }
  noteScanRoot = noteRoot;
  const index = await notesIndexPayload();
  const snippets = await scanSnippets();
  const templates = await scanTemplates();
  return { type: "open", file: "", title: "Noema", mode: "markdown", content: "# Noema\n\nSelect a note from the left, or keep this scratch buffer.", ...index, snippets, templates, root: noteRoot, noteDir: "." };
}

export async function getTodos(file = "", options = {}) {
  const request = file && typeof file === "object" ? file : { file, ...options };
  const requestedFile = String(request.file || "");
  if (requestedFile) {
    const safe = safeOpenFile(requestedFile);
    if (standaloneFile(safe)) {
      noteScanRoot = scanRootForOpenFile(safe);
    }
    const note = await noteFromFileForIndex(safe);
    const todos = note ? await todosForNote(note) : [];
    return { type: "todos", todos, root: noteScanRoot, source: "scan" };
  }
  return { type: "todos", todos: await scanTodos(), root: noteScanRoot, source: "scan" };
}
