// Built once per test run: the kernel's Wiki indexer, which owns wiki.db
// (docs/noema/design/wiki-workspace.md "Index ownership"). Go caches the
// build, so an unchanged kernel costs a second.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const KERNEL_WIKIINDEX_BIN = resolve(process.cwd(), "node_modules/.cache/noema/noema-wikiindex");

export default function setup(): void {
  mkdirSync(dirname(KERNEL_WIKIINDEX_BIN), { recursive: true });
  execFileSync("go", ["build", "-tags", "fts5", "-o", KERNEL_WIKIINDEX_BIN, "./cmd/noema-wikiindex"], {
    cwd: resolve(process.cwd(), "kernel"),
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, CGO_ENABLED: "1", CGO_CFLAGS: "-Wno-pointer-sign" },
  });
}
