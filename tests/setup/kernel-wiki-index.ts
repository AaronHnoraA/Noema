// Every suite builds Wiki indexes the way the host does: through the kernel.
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
// @ts-ignore Node ESM module outside the TS app graph.
import { configureWikiIndexBuilder } from "../../server/lib/wiki-workspace.mjs";

const run = promisify(execFile);
const bin = resolve(process.cwd(), "node_modules/.cache/noema/noema-wikiindex");

configureWikiIndexBuilder(async (root: string, { full }: { full: boolean }) => {
  const { stdout } = await run(bin, ["-refresh", root, ...(full ? ["-full"] : [])], { maxBuffer: 1024 * 1024 * 256 });
  return JSON.parse(stdout);
});
