import { readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const DEFAULT_IGNORED_PARTS = new Set([
  ".agent", ".git", ".ipynb_checkpoints", ".noema", ".venv", "__pycache__",
  "node_modules",
]);

function isResearchDocument(file) {
  const lower = String(file || "").toLowerCase();
  return lower.endsWith(".noema") || lower.endsWith(".noema.ipynb");
}

function insideRoot(root, file) {
  const rel = relative(root, file);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function researchNotebookWatchFile(root, file, ignoredParts = DEFAULT_IGNORED_PARTS) {
  const absoluteRoot = resolve(root);
  const absoluteFile = resolve(file);
  if (!insideRoot(absoluteRoot, absoluteFile) || !isResearchDocument(absoluteFile)) return "";
  const parts = relative(absoluteRoot, absoluteFile).split(sep);
  return parts.some((part) => ignoredParts.has(part)) ? "" : absoluteFile;
}

export function researchNotebookWatchDirectory(root, file, ignoredParts = DEFAULT_IGNORED_PARTS) {
  const absoluteRoot = resolve(root);
  const absoluteFile = resolve(file);
  if (!insideRoot(absoluteRoot, absoluteFile)) return "";
  const parts = relative(absoluteRoot, absoluteFile).split(sep);
  return parts.some((part) => ignoredParts.has(part)) ? "" : absoluteFile;
}

async function discoverResearchNotebooks(root, readDirectory, ignoredParts, onError) {
  const found = [];
  const stack = [root];
  while (stack.length > 0) {
    const directory = stack.pop();
    let entries;
    try {
      entries = await readDirectory(directory, { withFileTypes: true });
    } catch (error) {
      onError(error, directory);
      continue;
    }
    for (const entry of entries) {
      if (ignoredParts.has(entry.name)) continue;
      const file = join(directory, entry.name);
      if (entry.isDirectory()) stack.push(file);
      else if (entry.isFile() && isResearchDocument(entry.name)) found.push(file);
    }
  }
  return found.sort();
}

export function createResearchNotebookWatchReconciler({
  root,
  snapshot,
  readDirectory = readdir,
  ignoredParts = DEFAULT_IGNORED_PARTS,
  onError = () => {},
} = {}) {
  const absoluteRoot = resolve(String(root || "."));
  let closed = false;
  let queue = Promise.resolve();

  async function reconcile(files, reason) {
    const candidates = [...new Set(files.map((file) => researchNotebookWatchFile(absoluteRoot, file, ignoredParts)).filter(Boolean))].sort();
    for (const file of candidates) {
      if (closed) return;
      try {
        await snapshot({ file, actor: "watcher:external", reason });
      } catch (error) {
        if (["ERR_RESEARCH_FORMAT", "ERR_RESEARCH_NOT_FOUND"].includes(error?.code) || error?.code === "ENOENT") continue;
        onError(error, file);
      }
    }
  }

  function enqueue(task) {
    const next = queue.then(() => closed ? undefined : task());
    queue = next.catch(() => {});
    return next;
  }

  return {
    filesChanged(files = []) {
      return enqueue(() => reconcile(files, "external.file-change"));
    },
    fullRescan() {
      return enqueue(async () => reconcile(
        await discoverResearchNotebooks(absoluteRoot, readDirectory, ignoredParts, onError),
        "external.full-rescan",
      ));
    },
    drain() {
      return queue;
    },
    close() {
      closed = true;
    },
  };
}
