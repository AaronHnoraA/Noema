import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { documentAssetError } from "./document-excerpts.mjs";

const command = promisify(execFile);
const PATCH_LINES = 200;
const gitFormat = "%H%x00%h%x00%as%x00%an%x00%s";
const jjFieldSeparator = String.raw`"\0"`;
const jjFormat = ["commit_id", "commit_id.short(8)", 'author.timestamp().format("%Y-%m-%d")',
  "author.name()", "description.first_line()"].map((field) => `${field} ++ ${jjFieldSeparator}`).join(" ++ ");

const within = (root, path) => {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

async function repositoryNear(directory, root, requested) {
  for (let candidate = directory; within(root, candidate); candidate = dirname(candidate)) {
    const providers = requested === "auto" ? ["jj", "git"] : [requested];
    for (const provider of providers) {
      if (!existsSync(join(candidate, `.${provider}`))) continue;
      const repository = { root: candidate, provider };
      const command = provider === "git" ? ["rev-parse", "--show-toplevel"] : ["workspace", "root"];
      const reported = await run(repository, command).catch((error) => {
        if (error.statusCode === 422) return "";
        throw error;
      });
      if (reported && await realpath(reported.replace(/\r?\n$/, "")).catch(() => "") === candidate) return repository;
    }
    if (candidate === root || dirname(candidate) === candidate) break;
  }
  throw documentAssetError("No matching Git or Jujutsu repository in the note's content root", 404);
}

async function run(repository, args) {
  const { root, provider } = repository;
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1" };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) delete env[name];
  const flags = provider === "git"
    ? ["--no-pager", "--literal-pathspecs", "-c", "core.fsmonitor=false"]
    : ["--no-pager", "--color=never", "--ignore-working-copy", "--repository", root];
  try {
    return (await command(provider, [...flags, ...args], { cwd: root, env, timeout: 8000, maxBuffer: 1024 * 1024 })).stdout;
  } catch (error) {
    if (error?.code === "ENOENT") throw documentAssetError(`The ${provider} command is unavailable`, 503);
    if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw documentAssetError("Repository output exceeds the preview limit", 413);
    if (error?.killed) throw documentAssetError("Reading the repository timed out", 504);
    throw documentAssetError("The requested repository view is unavailable", 422);
  }
}

function rowsOfHistory(raw) {
  const columns = raw.split("\0");
  const commits = [];
  for (let index = 0; index + 4 < columns.length; index += 5) {
    const [id, short, date, author, subject] = columns.slice(index, index + 5);
    if (!/^[a-f\d]{40,64}$/i.test(id)) continue;
    commits.push({ id, short, date, author, subject });
  }
  return commits;
}

function jjRange(range) {
  if (!range) return [];
  const ends = /^(.*?)\.\.(\.?)(.*)$/.exec(range);
  if (!ends || ends[2] || !ends[1] || !ends[3]) return [`--revisions=${range}`];
  return [`--from=${ends[1]}`, `--to=${ends[3]}`];
}

export async function readRepositoryDocumentView({ root, start, filter, fallbackFilter, kind, vcs, limit, range }) {
  const requested = String(vcs || "auto").trim().toLowerCase();
  if (!["auto", "git", "jj"].includes(requested)) throw documentAssetError("Choose auto, git, or jj", 400);
  if (kind !== "git-log" && kind !== "git-diff") throw documentAssetError("Choose repository history or patch", 400);
  const repository = await repositoryNear(start, root, requested);
  if (filter && !within(repository.root, filter)) throw documentAssetError("The selected path is outside the repository", 403);
  const git = repository.provider === "git";
  const pathsFor = (path) => {
    const rel = path ? relative(repository.root, path).split(sep).join("/") : "";
    return ["--", ...(rel ? [git ? rel : `root:${JSON.stringify(rel)}`] : [])];
  };
  const header = { ok: true, provider: repository.provider, label: basename(repository.root) };
  const historyArgs = (count) => git ? ["log", "-z", "--no-show-signature", `--format=${gitFormat}`, `-n${count}`]
    : ["log", "--no-graph", "-r", "::@ ~ root()", "-n", String(count), "-T", jjFormat];
  let paths = pathsFor(filter);
  const fallback = fallbackFilter?.(repository.root);
  if (fallback && fallback !== filter && within(repository.root, fallback)) {
    const probes = git ? ["log", "--all", "--no-show-signature", "--format=%H", "-n1"] : historyArgs(1);
    const tracked = await run(repository, [...probes, ...paths]);
    if (!tracked) paths = pathsFor(fallback);
  }
  if (kind === "git-log") {
    const count = Number(limit ?? 8);
    if (!Number.isInteger(count) || count < 1 || count > 50) throw documentAssetError("History limit must be between 1 and 50", 400);
    if (git) {
      const ref = await run(repository, ["rev-parse", "--verify", "--quiet", "HEAD"]).catch((error) => {
        if (error.statusCode === 422) return "";
        throw error;
      });
      if (!ref) return { ...header, commits: [] };
    }
    return { ...header, commits: rowsOfHistory(await run(repository, [...historyArgs(count), ...paths])) };
  }

  const revisions = String(range || "").trim();
  if (revisions.length > 256 || revisions.startsWith("-") || /[\0\r\n]/.test(revisions)) {
    throw documentAssetError("Invalid revision range", 400);
  }
  const options = git ? ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--unified=3", ...(revisions ? [revisions] : [])]
    : ["diff", "--git", "--context=3", ...jjRange(revisions)];
  const patch = await run(repository, [...options, ...paths]);
  const lines = patch.split("\n");
  const truncated = lines.length - Number(lines.at(-1) === "") > PATCH_LINES;
  return { ...header, patch: truncated ? `${lines.slice(0, PATCH_LINES).join("\n")}\n` : patch, truncated };
}
