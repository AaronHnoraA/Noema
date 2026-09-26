// Noema Project model (D-038).
//
// `noema.toml` can declare two independent things:
//
//   schema = 1
//   repository_id = "…"      # a Wiki repository: the Git sync unit
//   [project]
//   id = "…"                  # a research Project: Runs, Sessions, `.agent/`
//   workspace = "../code"     # optional: where its agents execute
//
// A Wiki repository is not a Project.  Wiki registration writes a manifest
// into every Git repository of the vault, so treating any manifest as a
// Project would turn a whole vault into one research project.  A Project is
// the nearest manifest with a `[project]` table; a pre-D-038 manifest without
// one still counts when its `.agent/state.sqlite` shows Runs already live
// there, and keeps its `repository_id` as its Project id.
//
// The workspace is where agents run, `git.diff` is taken and Run file changes
// are detected.  It defaults to the Project root and may lie outside it.
// Paths reaching this module are client-side native paths; a logical `/fs:`
// name must be projected by the editor first.

import { existsSync, readFileSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { researchError } from "./research-notebook.mjs";

export const PROJECT_MANIFEST = "noema.toml";
const LEGACY_PROJECT_STATE = join(".agent", "state.sqlite");

function tomlString(raw) {
  const text = String(raw || "").trim();
  const basic = /^"((?:[^"\\]|\\.)*)"/.exec(text);
  if (basic) return basic[1].replace(/\\(["\\])/g, "$1");
  const literal = /^'([^']*)'/.exec(text);
  return literal ? literal[1] : "";
}

/** Parse the subset of `noema.toml` the Project model reads. */
export function parseProjectManifest(text) {
  const top = {};
  const project = {};
  let table = "";
  let hasProjectTable = false;
  for (const line of String(text || "").split(/\r?\n/)) {
    const header = /^\s*\[\s*([^\]]+?)\s*\]\s*(?:#.*)?$/.exec(line);
    if (header) {
      table = header[1];
      if (table === "project") hasProjectTable = true;
      continue;
    }
    const pair = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (!pair) continue;
    if (table === "") top[pair[1]] = pair[2];
    else if (table === "project") project[pair[1]] = pair[2];
  }
  return {
    repositoryId: tomlString(top.repository_id),
    hasProjectTable,
    projectId: tomlString(project.id),
    workspace: tomlString(project.workspace),
  };
}

function manifestTextSync(directory) {
  try {
    return readFileSync(join(directory, PROJECT_MANIFEST), "utf8");
  } catch {
    return null;
  }
}

/** Return non-nil when DIRECTORY is a Noema Project root (see module doc). */
export function isResearchProjectRootSync(directory) {
  const text = manifestTextSync(directory);
  if (text === null) return false;
  if (parseProjectManifest(text).hasProjectTable) return true;
  return existsSync(join(directory, LEGACY_PROJECT_STATE));
}

function assertClientPath(start) {
  const value = String(start || "").trim();
  if (value.startsWith("/fs:") || /^\/[A-Za-z0-9-]+:[^/]*:/.test(value)) {
    throw researchError(
      `Noema needs a client-side path, not the logical name ${value}; the editor must project it first`,
      422, "ERR_RESEARCH_ROOT");
  }
  if (!value || !isAbsolute(value)) {
    throw researchError("A project root or absolute cwd is required", 400, "ERR_RESEARCH_ROOT");
  }
  return resolve(value);
}

/** Return the nearest Project root at or above START, or throw. */
export async function findResearchProjectRoot(start) {
  let current = assertClientPath(start);
  // START may name a document that is about to be created; its directory
  // must exist.
  const info = await stat(current).catch(() => null);
  if (!info?.isDirectory()) {
    const parent = dirname(current);
    if (!info && !(await stat(parent).catch(() => null))?.isDirectory()) {
      throw researchError(`Research project path does not exist: ${current}`, 404, "ERR_RESEARCH_ROOT");
    }
    current = parent;
  }
  for (;;) {
    if (isResearchProjectRootSync(current)) return current;
    const parent = dirname(current);
    if (parent === current) {
      throw researchError(`No Noema project (a noema.toml with [project]) above ${start}`, 404, "ERR_RESEARCH_ROOT");
    }
    current = parent;
  }
}

/** Like `findResearchProjectRoot', but return null instead of throwing. */
export async function findResearchProjectRootOrNull(start) {
  try {
    return await findResearchProjectRoot(start);
  } catch {
    return null;
  }
}

function expandWorkspace(root, value) {
  const text = String(value || "").trim();
  if (!text) return root;
  if (text === "~") return homedir();
  if (text.startsWith("~/")) return join(homedir(), text.slice(2));
  return resolve(root, text);
}

/**
 * Return `{ root, id, workspace, declaredWorkspace }` for Project ROOT.
 * WORKSPACE is absolute; an explicitly declared one must be an existing
 * directory, so a stale declaration fails loudly instead of running agents
 * in the Project root.
 */
export async function readProjectLayout(root) {
  const text = await readFile(join(root, PROJECT_MANIFEST), "utf8");
  const manifest = parseProjectManifest(text);
  const id = manifest.projectId || manifest.repositoryId;
  if (!id) throw researchError("noema.toml declares no [project] id", 422, "ERR_RESEARCH_PROJECT_ID");
  const workspace = expandWorkspace(root, manifest.workspace);
  if (manifest.workspace) {
    let directory = false;
    try {
      directory = statSync(workspace).isDirectory();
    } catch {
      directory = false;
    }
    if (!directory) {
      throw researchError(`Project workspace does not exist: ${workspace}`, 422, "ERR_RESEARCH_WORKSPACE");
    }
  }
  return { root, id, workspace, declaredWorkspace: manifest.workspace };
}
