export const DEFAULT_WIKI_FULL_REFRESH_PROBABILITY = 0.1;

function finiteProbability(value, fallback = DEFAULT_WIKI_FULL_REFRESH_PROBABILITY) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : fallback;
}

export function wikiFullRefreshProbability(value) {
  return finiteProbability(value);
}

function addFile(files, value) {
  const file = String(value || "").trim();
  if (file) files.add(file);
}

/**
 * Normalize the deliberately small family of mutation result shapes emitted
 * by the runtime and Wiki APIs.  Keeping this in one place makes every
 * first-party mutation participate in the same DB invalidation path.
 */
export function wikiMutationFiles(result, fallbackFiles = []) {
  const files = new Set();
  for (const file of fallbackFiles || []) addFile(files, file);
  if (!result || typeof result !== "object") return [...files];

  for (const key of [
    "file", "oldFile", "survivorFile", "redirectFile", "outputFile", "jsFile", "cssFile",
  ]) addFile(files, result[key]);
  if (result.type === "wiki-page-moved") addFile(files, result.source);

  for (const file of Array.isArray(result.changedPaths) ? result.changedPaths : []) {
    addFile(files, file);
  }
  for (const item of Array.isArray(result.changed) ? result.changed : []) {
    if (typeof item === "string") addFile(files, item);
    else if (item && typeof item === "object") addFile(files, item.file);
  }
  for (const item of Array.isArray(result.trashed) ? result.trashed : []) {
    if (typeof item === "string") addFile(files, item);
    else if (item && typeof item === "object") addFile(files, item.file);
  }
  return [...files];
}

export function coalesceWikiRefreshMode(current = "auto", requested = "auto") {
  const rank = { auto: 0, incremental: 1, full: 2 };
  const left = Object.hasOwn(rank, current) ? current : "auto";
  const right = Object.hasOwn(rank, requested) ? requested : "auto";
  return rank[right] > rank[left] ? right : left;
}

/** Plan the DB refresh only after a Git operation reached a stable worktree. */
export function wikiSyncIndexRefreshPlan(result, options = {}) {
  if (!result || result.phase !== "idle") return null;
  const probability = finiteProbability(options.fullProbability);
  const random = typeof options.random === "function" ? options.random : Math.random;
  return {
    mode: random() < probability ? "full" : "incremental",
    changedFiles: wikiMutationFiles(result),
    fullProbability: probability,
  };
}
