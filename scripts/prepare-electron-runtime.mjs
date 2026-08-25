import { mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";

const extension = process.platform === "win32" ? ".exe" : "";
const goos = process.platform === "win32" ? "windows" : process.platform;
const goarch = process.arch === "x64" ? "amd64" : process.arch;
const destination = resolve("build", "kernel", `${goos}-${goarch}`, `noema-kernel${extension}`);

await mkdir(dirname(destination), { recursive: true });
const build = spawnSync(
  "go",
  ["build", "-tags", "fts5", "-ldflags", "-s -w", "-o", destination, "."],
  {
    cwd: resolve("kernel"),
    env: { ...process.env, CGO_ENABLED: "1", GOOS: goos, GOARCH: goarch },
    stdio: "inherit",
  },
);
if (build.error) throw build.error;
if (build.status !== 0) throw new Error(`Noema kernel build failed with status ${build.status}`);
console.log(`[noema-electron] Go kernel -> ${destination}`);
