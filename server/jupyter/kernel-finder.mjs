// Kernelspec discovery.
// Ported concept from microsoft/vscode-jupyter (MIT)
// src/kernels/raw/finder/jupyterPaths.node.ts + localKnownPathKernelSpecFinder.node.ts,
// reimplemented directly against Node's fs (no DI/VS Code ceremony). Mirrors
// the same search-path scheme jupyter/scripts/run-jupyter-server.sh used to
// export for the (now retired) jupyter-server process, so kernel visibility
// doesn't change under the raw-ZMQ swap: JUPYTER_PATH entries, this project's
// own data dir, optionally the user/system Jupyter dirs, and an optional
// environment's own `share/jupyter` prefix.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Search directories to scan for `<dir>/kernels/<name>/kernel.json`, in priority order (first match per name wins). */
export function defaultKernelSearchDirs({ dataDir, environmentPrefix, venvPrefix, useHomeKernels = true, extraJupyterPath }) {
  const dirs = [];
  if (extraJupyterPath) {
    dirs.push(...String(extraJupyterPath).split(path.delimiter).map((p) => p.trim()).filter(Boolean));
  }
  if (dataDir) dirs.push(dataDir);
  if (useHomeKernels) {
    const home = os.homedir();
    if (home) {
      dirs.push(path.join(home, "Library", "Jupyter"));
      dirs.push(path.join(home, ".local", "share", "jupyter"));
    }
    dirs.push("/usr/local/share/jupyter", "/usr/share/jupyter");
  }
  const prefix = environmentPrefix || venvPrefix;
  if (prefix) dirs.push(path.join(prefix, "share", "jupyter"));
  return dirs;
}

/**
 * Scan `searchDirs` for kernelspecs. Returns a list of
 * `{ name, spec, resourceDir }`, `spec` being the parsed `kernel.json`.
 * Directories earlier in `searchDirs` take priority for a given kernel name.
 */
export async function findKernelSpecs({ searchDirs, allowedNames }) {
  const seen = new Map();
  for (const dir of searchDirs) {
    const kernelsDir = path.join(dir, "kernels");
    let entries;
    try {
      entries = await fs.readdir(kernelsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || seen.has(entry.name)) continue;
      const resourceDir = path.join(kernelsDir, entry.name);
      try {
        const raw = await fs.readFile(path.join(resourceDir, "kernel.json"), "utf8");
        const spec = JSON.parse(raw);
        if (!Array.isArray(spec.argv) || spec.argv.length === 0) continue;
        seen.set(entry.name, { name: entry.name, spec, resourceDir });
      } catch {
        continue;
      }
    }
  }
  let list = Array.from(seen.values());
  if (allowedNames && allowedNames.length > 0) {
    const allow = new Set(allowedNames);
    list = list.filter((k) => allow.has(k.name));
  }
  // A project-owned stable `sagemath` spec supersedes version-named local or
  // system Sage specs.  Remote kernels keep their own ids (for example
  // rik_ssh_*_sage) and are intentionally unaffected.
  if (list.some((kernel) => kernel.name === "sagemath")) {
    list = list.filter((kernel) => kernel.name === "sagemath"
      || !/^sagemath(?:[-_.]?\d)/i.test(kernel.name));
  }
  return list;
}

/**
 * Scan `attachDirs` for standalone kernel connection files (as written by
 * `jupyter kernel` / a remembered `kernel-*.json`, e.g. from an Emacs-managed
 * remote kernel workflow). Returns `{ token, path, mtimeMs }[]`, most recent
 * first; `token` is the string a caller writes as `attach:<token>` to select it.
 */
export async function findAttachableConnectionFiles(attachDirs) {
  const results = [];
  for (const dir of attachDirs) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const filePath = path.join(dir, entry.name);
      try {
        const raw = await fs.readFile(filePath, "utf8");
        const info = JSON.parse(raw);
        if (!info || typeof info.shell_port !== "number" || typeof info.iopub_port !== "number") continue;
        const stat = await fs.stat(filePath);
        results.push({ token: entry.name, path: filePath, mtimeMs: stat.mtimeMs, connectionInfo: info });
      } catch {
        continue;
      }
    }
  }
  results.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return results;
}

/** Resolve an `attach:<token>` kernel name to a connection-file path. */
export async function resolveAttachToken(token, attachDirs) {
  if (path.isAbsolute(token)) return token;
  for (const dir of attachDirs) {
    const candidate = path.join(dir, token);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}
