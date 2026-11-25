import { opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

const DEFAULT_IGNORE = new Set([".git", ".jj", ".hg", ".svn", "node_modules", "__pycache__", ".DS_Store"]);
const order = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export async function readProjectDirectory(directory, depth, ignoredNames) {
  const ignored = new Set([...DEFAULT_IGNORE, ...ignoredNames]);
  let remaining = 150;
  let truncated = false;
  const scan = async (parent, depthLeft, prefix) => {
    const canonical = await realpath(parent).catch((error) => {
      if (error?.code === "ENOENT") return "";
      throw error;
    });
    const subpath = canonical && relative(directory, canonical);
    if (!canonical || subpath === ".." || subpath.startsWith(`..${sep}`) || isAbsolute(subpath)) return [];
    const entries = [];
    const listing = await opendir(canonical);
    let inspected = 0;
    for await (const entry of listing) {
      if (++inspected > 4096 || entries.length >= 512) { truncated = true; break; }
      if (ignored.has(entry.name) || entry.name.endsWith(".elc") || !(entry.isFile() || entry.isDirectory())) continue;
      entries.push(entry);
    }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory())
      || order.compare(a.name, b.name) || a.name.localeCompare(b.name));
    const result = [];
    for (const entry of entries) {
      if (remaining <= 0) { truncated = true; break; }
      remaining--;
      const file = join(parent, entry.name);
      const key = `${prefix}${entry.name}`;
      const directory = entry.isDirectory();
      const children = directory && depthLeft > 1 ? await scan(file, depthLeft - 1, `${key}/`) : [];
      result.push({ label: entry.name, key, file, directory, children });
    }
    return result;
  };
  const entries = await scan(directory, depth, "");
  return { entries, truncated };
}
