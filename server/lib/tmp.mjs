import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";

let tmpRoot = resolve(process.env.AARONNOTE_TMP_DIR || join(tmpdir(), "aaronnote"));

function safeKind(kind) {
  return String(kind || "runtime").replace(/[^A-Za-z0-9._-]+/g, "-") || "runtime";
}

function safeReadablePath(filePath) {
  const raw = resolve(String(filePath || "scratch"));
  const readable = raw
    .split(sep)
    .filter(Boolean)
    .join("_")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const fallback = basename(raw).replace(/[^A-Za-z0-9._-]+/g, "-") || "scratch";
  return (readable || fallback).slice(-96);
}

export function configureTmpRoot(root) {
  const next = String(root || process.env.AARONNOTE_TMP_DIR || "").trim();
  tmpRoot = resolve(next || join(tmpdir(), "aaronnote"));
  return tmpRoot;
}

export function aaronnoteTmpRoot() {
  return tmpRoot;
}

export function encodeOriginalPathToTmpName(filePath) {
  const resolved = resolve(String(filePath || "scratch"));
  const hash = createHash("sha256").update(resolved).digest("hex").slice(0, 12);
  return `${safeReadablePath(resolved)}--${hash}`;
}

export async function runtimeTmpDir(kind = "runtime") {
  const dir = join(tmpRoot, safeKind(kind));
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function runtimeTmpFile(kind, originalPath, suffix = ".tmp") {
  const dir = await runtimeTmpDir(kind);
  const cleanSuffix = String(suffix || ".tmp").startsWith(".") ? String(suffix || ".tmp") : `.${suffix}`;
  return join(dir, `${safeKind(kind)}--${encodeOriginalPathToTmpName(originalPath)}${cleanSuffix}`);
}

export async function runtimeMkdtemp(kind, originalPath = "") {
  const dir = await runtimeTmpDir(kind);
  const prefix = `${safeKind(kind)}--${encodeOriginalPathToTmpName(originalPath || kind)}--`;
  return mkdtemp(join(dir, prefix));
}

// One-shot orphan sweep at server startup. Removes entries older than ttlMs
// under each kind subdirectory of tmpRoot. maxEntries is a safety cap to avoid
// stat-ing an unexpectedly large directory. No recurring timer.
export async function sweepRuntimeTmp({ ttlMs = 24 * 60 * 60 * 1000, maxEntries = 2000 } = {}) {
  const now = Date.now();
  let scanned = 0;
  let removed = 0;
  let kindDirs;
  try {
    kindDirs = await readdir(tmpRoot, { withFileTypes: true });
  } catch {
    return { scanned, removed };
  }
  for (const kindEntry of kindDirs) {
    if (!kindEntry.isDirectory()) continue;
    const kindPath = join(tmpRoot, kindEntry.name);
    let entries;
    try {
      entries = await readdir(kindPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (scanned >= maxEntries) break;
      scanned++;
      const entryPath = join(kindPath, entry.name);
      try {
        const info = await stat(entryPath);
        if (now - info.mtimeMs > ttlMs) {
          await rm(entryPath, { recursive: true, force: true });
          removed++;
        }
      } catch {
        // skip unreadable or already-gone entries
      }
    }
  }
  return { scanned, removed };
}
