import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const execFileAsync = promisify(execFile);

const MAX_BUFFER = 1024 * 1024 * 4;

async function git(noteRoot, args) {
  const { stdout } = await execFileAsync("git", ["-C", noteRoot, ...args], {
    maxBuffer: MAX_BUFFER,
  });
  return stdout.trim();
}

async function gitRaw(noteRoot, args) {
  const { stdout } = await execFileAsync("git", ["-C", noteRoot, ...args], {
    maxBuffer: MAX_BUFFER,
  });
  return stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
}

async function gitOutput(noteRoot, args) {
  try {
    const { stdout, stderr } = await execFileAsync("git", ["-C", noteRoot, ...args], {
      maxBuffer: MAX_BUFFER,
    });
    return { ok: true, code: 0, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err) {
    return {
      ok: false,
      code: Number(err?.code) || 1,
      stdout: String(err?.stdout || "").trim(),
      stderr: String(err?.stderr || "").trim(),
      message: err?.message || "Git command failed",
    };
  }
}

async function realResolve(path) {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

function slashPath(path) {
  return String(path || "").split(sep).join("/");
}

function stripGitQuotes(value) {
  const text = String(value || "");
  return text.startsWith("\"") && text.endsWith("\"") ? text.slice(1, -1) : text;
}

function statusKind(x, y) {
  if (x === "?" && y === "?") return "untracked";
  if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) return "conflict";
  const code = x !== " " ? x : y;
  if (code === "A") return "added";
  if (code === "M") return "modified";
  if (code === "D") return "deleted";
  if (code === "R") return "renamed";
  if (code === "C") return "copied";
  return "changed";
}

function statusSummary(x, y) {
  if (x === "?" && y === "?") return "Untracked";
  const parts = [];
  if (x !== " ") parts.push("index " + x);
  if (y !== " ") parts.push("worktree " + y);
  return parts.join(", ") || "Clean";
}

async function resolveNotePathInfo(noteRoot, pathValue) {
  const noteRootAbs = await realResolve(noteRoot);
  const root = await gitRoot(noteRoot);
  const raw = String(pathValue || "").trim();
  if (!raw) throw new Error("Missing path");
  const requestedAbs = isAbsolute(raw) ? resolve(raw) : resolve(noteRootAbs, raw);
  const abs = await realResolve(requestedAbs);
  if (abs !== noteRootAbs && !abs.startsWith(noteRootAbs + sep)) {
    throw new Error("File outside noteRoot: " + pathValue);
  }
  return {
    abs,
    noteRel: slashPath(relative(noteRootAbs, abs)),
    gitRel: slashPath(relative(root, abs)),
  };
}

function untrackedFileDiff(path, content) {
  const lines = String(content || "").split(/\r?\n/);
  if (lines.length > 0 && lines.at(-1) === "") lines.pop();
  return [
    "diff --git a/" + path + " b/" + path,
    "new file mode 100644",
    "index 0000000..0000000",
    "--- /dev/null",
    "+++ b/" + path,
    "@@ -0,0 +1 @@",
    ...lines.map((line) => "+" + line),
  ].join("\n");
}

// Resolves the git repository root from noteRoot (follows symlinks via git itself).
// Cached by noteRoot value — invalidated automatically when noteRoot changes.
let cachedGitRootKey = null;
let cachedGitRootValue = null;
async function gitRoot(noteRoot) {
  if (cachedGitRootKey !== noteRoot) {
    cachedGitRootValue = await git(noteRoot, ["rev-parse", "--show-toplevel"]);
    cachedGitRootKey = noteRoot;
  }
  return cachedGitRootValue;
}

async function noteRootPathspec(noteRoot) {
  const rootReal = await realResolve(await gitRoot(noteRoot));
  const noteRootReal = await realResolve(noteRoot);
  if (noteRootReal === rootReal) return ".";
  if (!noteRootReal.startsWith(rootReal + sep)) return ".";
  return `:(top)${slashPath(relative(rootReal, noteRootReal))}`;
}

// Resolves a git-output path (relative to git root) to an absolute path,
// then returns it only if it lives inside noteRoot.
async function resolveGitPath(noteRoot, gitRelPath) {
  const root = await gitRoot(noteRoot);
  const abs = await realResolve(resolve(root, gitRelPath));
  // Must be inside noteRoot (which may be a symlink; git resolves real paths)
  const noteRootReal = await realResolve(noteRoot);
  return (abs === noteRootReal || abs.startsWith(noteRootReal + sep)) ? abs : null;
}

// Returns current HEAD sha, or null if not in a git repo / no commits yet.
export async function headSha(noteRoot) {
  try {
    return await git(noteRoot, ["rev-parse", "HEAD"]);
  } catch {
    return null;
  }
}

// Returns absolute paths of roam .md/.markdown files that changed since `commit`.
// Covers both committed changes (diff against HEAD) and uncommitted working tree changes.
// Returns null to signal "fall back to full rebuild" (bad commit ref or not a repo).
export async function changedRoamFilesSince(noteRoot, commit) {
  if (!commit) return null;

  const mdPattern = /\.(?:md|markdown)$/i;
  const paths = new Set();

  // Committed changes since the recorded commit
  // git diff --name-only outputs paths relative to git root, not cwd
  try {
    const out = await git(noteRoot, [
      "diff", "--name-only", "--diff-filter=AMRCD", commit, "HEAD", "--",
    ]);
    for (const line of out.split("\n")) {
      const p = line.trim();
      if (!p || !mdPattern.test(p)) continue;
      const abs = await resolveGitPath(noteRoot, p);
      if (abs) paths.add(abs);
    }
  } catch {
    // commit no longer exists (e.g. after rebase/squash) — signal full rebuild
    return null;
  }

  // Uncommitted working-tree + index changes
  // git status --porcelain also outputs paths relative to git root
  try {
    const out = await gitRaw(noteRoot, ["status", "--porcelain", "--"]);
    for (const line of out.split("\n")) {
      // format: "XY path"  or  "XY old -> new"
      const raw = line.slice(3).trim();
      const p = raw.includes(" -> ") ? raw.split(" -> ")[1] : raw;
      if (!p || !mdPattern.test(p)) continue;
      const abs = await resolveGitPath(noteRoot, p.replace(/"/g, ""));
      if (abs) paths.add(abs);
    }
  } catch {
    // not fatal — working tree status is best-effort
  }

  return [...paths];
}

// Stages all changes in noteRoot and commits if there are staged changes.
// Scoped to noteRoot via "." pathspec — never touches unrelated staged changes.
// .gitignore handles exclusions (roam.db, .aaronnote-sync-state.json, etc.).
// Returns the new HEAD sha (or current HEAD if nothing was committed).
export async function commitRoam(noteRoot, message) {
  try {
    await git(noteRoot, ["add", "--", "."]);
  } catch {
    // not fatal if nothing to stage
  }

  // Check staged changes scoped to noteRoot ("." = cwd = noteRoot with -C)
  try {
    await git(noteRoot, ["diff", "--cached", "--quiet", "--", "."]);
    // exit 0 → nothing staged → nothing to commit
    return headSha(noteRoot);
  } catch {
    // Non-zero exit = staged changes exist
    try {
      // Commit scoped to noteRoot so unrelated staged changes in parent repo are left alone
      await git(noteRoot, ["commit", "-m", message, "--", "."]);
    } catch (err) {
      // Non-fatal: git user not configured, nothing to commit after scope filter, etc.
      console.warn("[roam-git] commit failed:", err?.message);
    }
  }

  return headSha(noteRoot);
}

// Returns { branch, ahead, behind, uncommitted, remoteUrl } for the roam repo.
export async function roamRepoStatus(noteRoot) {
  let branch = "", ahead = 0, behind = 0, uncommitted = false, remoteUrl = "";
  try {
    branch = await git(noteRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  } catch {}
  try {
    remoteUrl = await git(noteRoot, ["config", "--get", "remote.origin.url"]);
  } catch {}
  if (remoteUrl) {
    try {
      await git(noteRoot, ["fetch", "--quiet"]);
    } catch {}
    try {
      const aheadBehind = await git(noteRoot, [
        "rev-list", "--left-right", "--count", `${branch}...origin/${branch}`,
      ]);
      const [a, b] = aheadBehind.split("\t").map(Number);
      ahead = a || 0;
      behind = b || 0;
    } catch {}
  }
  try {
    const scope = await noteRootPathspec(noteRoot);
    const out = await gitRaw(noteRoot, ["status", "--porcelain", "--untracked-files=all", "--", scope]);
    uncommitted = out.split("\n").some((line) => line.trim());
  } catch {}
  return { branch, ahead, behind, uncommitted, hasRemote: Boolean(remoteUrl), remoteUrl };
}

export async function roamRepoChanges(noteRoot) {
  const root = await gitRoot(noteRoot);
  const noteRootAbs = await realResolve(noteRoot);
  const scope = await noteRootPathspec(noteRoot);
  const out = await gitRaw(noteRoot, ["-c", "core.quotePath=false", "status", "--porcelain=v1", "--untracked-files=all", "--", scope]);
  if (!out) return [];
  const changes = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const x = line[0] || " ";
    const y = line[1] || " ";
    const raw = line.slice(3).trim();
    if (!raw) continue;
    const parts = raw.includes(" -> ") ? raw.split(" -> ") : [raw];
    const path = stripGitQuotes(parts.at(-1));
    const oldPath = parts.length > 1 ? stripGitQuotes(parts[0]) : "";
    const abs = await resolveGitPath(noteRoot, path);
    if (!abs) continue;
    changes.push({
      path: slashPath(relative(noteRootAbs, abs)),
      file: abs,
      gitPath: slashPath(relative(root, abs)),
      oldPath,
      status: x + y,
      staged: x !== " " && x !== "?",
      unstaged: y !== " " || (x === "?" && y === "?"),
      tracked: !(x === "?" && y === "?"),
      kind: statusKind(x, y),
      summary: statusSummary(x, y),
      isMarkdown: path.toLowerCase().endsWith(".md") || path.toLowerCase().endsWith(".markdown"),
    });
  }
  return changes;
}

export async function diffRoamFile(noteRoot, pathValue, options = {}) {
  const info = await resolveNotePathInfo(noteRoot, pathValue);
  const scope = options?.scope === "staged" || options?.scope === "working" ? options.scope : "all";
  const sha = String(options?.sha || "").trim();
  if (sha) {
    const out = await gitOutput(noteRoot, ["show", "--format=", "--no-ext-diff", "--unified=80", sha, "--", info.noteRel]);
    if (!out.ok && out.code !== 1) throw new Error(out.stderr || out.stdout || out.message);
    return { file: info.abs, path: info.noteRel, diff: out.stdout, scope: "commit", sha };
  }

  const changes = await roamRepoChanges(noteRoot);
  const change = changes.find((item) => item.path === info.noteRel || item.file === info.abs);
  if (change?.kind === "untracked") {
    const content = await readFile(info.abs, "utf8");
    return { file: info.abs, path: info.noteRel, diff: untrackedFileDiff(info.gitRel, content), scope: "working" };
  }

  const sections = [];
  if (scope === "all" || scope === "staged") {
    const staged = await gitOutput(noteRoot, ["diff", "--cached", "--no-ext-diff", "--unified=80", "--", info.noteRel]);
    if (!staged.ok && staged.code !== 1) throw new Error(staged.stderr || staged.stdout || staged.message);
    if (staged.stdout) sections.push(scope === "all" ? "# Staged\n" + staged.stdout : staged.stdout);
  }
  if (scope === "all" || scope === "working") {
    const working = await gitOutput(noteRoot, ["diff", "--no-ext-diff", "--unified=80", "--", info.noteRel]);
    if (!working.ok && working.code !== 1) throw new Error(working.stderr || working.stdout || working.message);
    if (working.stdout) sections.push(scope === "all" ? "# Working tree\n" + working.stdout : working.stdout);
  }
  return { file: info.abs, path: info.noteRel, diff: sections.join("\n\n"), scope };
}

export async function diffRoamCommit(noteRoot, sha) {
  const cleanSha = String(sha || "").trim();
  if (!cleanSha) throw new Error("Missing commit");
  const out = await gitOutput(noteRoot, ["show", "--no-ext-diff", "--unified=80", "--format=fuller", cleanSha, "--", "."]);
  if (!out.ok && out.code !== 1) throw new Error(out.stderr || out.stdout || out.message);
  return { sha: cleanSha, diff: out.stdout };
}

export async function pullRoam(noteRoot) {
  return git(noteRoot, ["pull", "--ff-only"]);
}

// Push roam repo to origin. Throws if no remote or push fails.
export async function pushRoam(noteRoot) {
  return git(noteRoot, ["push", "origin", "HEAD"]);
}

// Returns recent commits for the entire roam repo.
// Each entry: { sha, date, subject, files }
export async function repoHistory(noteRoot, limit = 30) {
  try {
    const out = await git(noteRoot, [
      "log", `--format=%H\t%cI\t%s`, `-n`, String(limit),
    ]);
    if (!out) return [];
    return out.split("\n").filter(Boolean).map((line) => {
      const [sha, date, ...rest] = line.split("\t");
      return { sha, date, subject: rest.join("\t") };
    });
  } catch {
    return [];
  }
}

// Returns recent commits that touched the given absolute file path.
// Each entry: { sha, date, subject }
export async function fileHistory(noteRoot, absFile, limit = 20) {
  // git log path args are relative to cwd (-C noteRoot), which git converts
  // to git-root-relative internally — this works correctly.
  const rel = relative(noteRoot, absFile);
  if (!rel || rel.startsWith("..")) return [];
  try {
    const out = await git(noteRoot, [
      "log", `--format=%H\t%cI\t%s`, `-n`, String(limit), "--", rel,
    ]);
    if (!out) return [];
    return out.split("\n").filter(Boolean).map((line) => {
      const [sha, date, ...rest] = line.split("\t");
      return { sha, date, subject: rest.join("\t") };
    });
  } catch {
    return [];
  }
}

// Restores the file at absFile to its contents at the given commit sha.
// Writes directly to the working tree; does NOT modify the git index.
export async function restoreFileFromCommit(noteRoot, absFile, sha) {
  const rel = relative(noteRoot, absFile);
  if (!rel || rel.startsWith("..")) throw new Error(`File outside noteRoot: ${absFile}`);
  // git show <sha>:<path> — path must be relative to git root.
  const root = await gitRoot(noteRoot);
  const gitRel = relative(root, absFile);
  const content = await git(noteRoot, ["show", `${sha}:${gitRel}`]);
  await writeFile(absFile, content, "utf8");
}

export async function discardFileChanges(noteRoot, pathValue) {
  const info = await resolveNotePathInfo(noteRoot, pathValue);
  const changes = await roamRepoChanges(noteRoot);
  const change = changes.find((item) =>
    item.file === info.abs
    || item.path === info.noteRel
    || item.gitPath === info.gitRel
  );
  if (!change) return { file: info.abs, path: info.noteRel, changed: false };

  const pathspecs = [`:(top)${info.gitRel}`];

  if (change.kind === "untracked" || change.kind === "added" || change.kind === "copied") {
    await gitOutput(noteRoot, ["restore", "--staged", "--", ...pathspecs]);
    await rm(info.abs, { force: true, recursive: false });
    return { file: info.abs, path: info.noteRel, changed: true };
  }

  if (change.kind === "renamed" && change.oldPath) {
    const out = await gitOutput(noteRoot, ["restore", "--source=HEAD", "--staged", "--worktree", "--", `:(top)${slashPath(change.oldPath)}`]);
    if (!out.ok) throw new Error(out.stderr || out.stdout || out.message || "Git restore failed");
    await rm(info.abs, { force: true, recursive: false });
    return { file: info.abs, path: info.noteRel, changed: true };
  }

  const out = await gitOutput(noteRoot, ["restore", "--source=HEAD", "--staged", "--worktree", "--", ...pathspecs]);
  if (!out.ok) throw new Error(out.stderr || out.stdout || out.message || "Git restore failed");
  return { file: info.abs, path: info.noteRel, changed: true };
}
