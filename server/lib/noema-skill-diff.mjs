// Single-document unified diffs. Never run a shell or patch a shared source.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";

const run = promisify(execFile);
const cache = new Map();
const limit = 1024 * 1024;
const hash = (text) => createHash("sha256").update(text).digest("hex");

async function workspace(fn) {
  const directory = await mkdtemp(join(tmpdir(), "noema-skill-diff-"));
  try { return await fn(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

export async function createSkillDiff(base, edited) {
  if (base === edited) return "";
  return workspace(async (cwd) => {
    await writeFile(join(cwd, "base"), base);
    await writeFile(join(cwd, "edited"), edited);
    try {
      await run("diff", ["-u", "-L", "SKILL.md", "-L", "SKILL.md", "base", "edited"], { cwd, timeout: 5000, maxBuffer: limit });
      return "";
    } catch (error) {
      if (error.code === 1 && error.stdout.startsWith("--- SKILL.md\n+++ SKILL.md\n")) return error.stdout;
      throw new Error("Could not generate Skill diff", { cause: error });
    }
  });
}

export async function applySkillDiff(base, diff, expectedHash) {
  if (Buffer.byteLength(diff) > limit || Buffer.byteLength(base) > limit) throw new Error("Skill patch input exceeds 1 MiB");
  if (expectedHash !== hash(base)) throw new Error("Global Skill changed: rebase this patch before use");
  if (!diff.trim()) return base;
  // No ed scripts, binary patches, multiple files, paths, or patch options.
  // Header-like lines inside hunks are excluded by parsing the hunk counts.
  const lines = diff.split("\n");
  if (lines.shift() !== "--- SKILL.md" || lines.shift() !== "+++ SKILL.md") throw new Error("Expected a single unified diff for SKILL.md");
  let old = 0, added = 0, hunks = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line === "\\ No newline at end of file") continue;
    if (!old && !added) {
      if (!line && index === lines.length - 1) continue;
      const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@(?: .*)?$/.exec(line);
      if (!hunk) throw new Error("Only unified diff hunks are accepted");
      old = Number(hunk[1] ?? 1); added = Number(hunk[2] ?? 1); hunks++;
    } else {
      if (line.startsWith(" ")) { old--; added--; }
      else if (line.startsWith("-")) old--;
      else if (line.startsWith("+")) added--;
      else throw new Error("Invalid unified diff hunk");
      if (old < 0 || added < 0) throw new Error("Invalid unified diff line counts");
    }
  }
  if (old || added || !hunks) throw new Error("Incomplete unified diff");
  const key = hash(base + "\0" + diff);
  if (cache.has(key)) return cache.get(key);
  const result = await workspace(async (cwd) => {
    await writeFile(join(cwd, "SKILL.md"), base);
    await writeFile(join(cwd, "change.patch"), diff);
    try {
      await run("patch", ["--posix", "-t", "-N", "-F", "0", "-r", "rejected", "SKILL.md", "change.patch"],
        { cwd, timeout: 5000, maxBuffer: limit });
    } catch (error) {
      throw new Error("Skill patch did not apply cleanly (patch required; no fuzz or partial result accepted)", { cause: error });
    }
    const content = await readFile(join(cwd, "SKILL.md"), "utf8");
    if (Buffer.byteLength(content) > limit) throw new Error("Patched Skill exceeds 1 MiB");
    return content;
  });
  // Bounded cache; resolution/repaint of unchanged patches starts no processes.
  while (cache.size >= 16) cache.delete(cache.keys().next().value);
  cache.set(key, result);
  return result;
}
