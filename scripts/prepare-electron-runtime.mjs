import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    ...options,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}`);
  }
}

// npm 11 can install the pinned Electron package without running its download
// lifecycle in restricted-script environments.  Keep the build reproducible by
// invoking Electron's own checksummed installer only when the runtime is absent.
const electronExecutable = resolve(
  "node_modules", "electron", "dist",
  process.platform === "darwin"
    ? "Electron.app/Contents/MacOS/Electron"
    : process.platform === "win32" ? "electron.exe" : "electron",
);
if (!existsSync(electronExecutable)) {
  const installer = resolve("node_modules", "electron", "install.js");
  if (!existsSync(installer)) {
    throw new Error("Pinned Electron package is missing; run npm ci first");
  }
  run(process.execPath, [installer]);
}

const extension = process.platform === "win32" ? ".exe" : "";
const goos = process.platform === "win32" ? "windows" : process.platform;
const goarch = process.arch === "x64" ? "amd64" : process.arch;
const destination = resolve("build", "kernel", `${goos}-${goarch}`, `noema-kernel${extension}`);

await mkdir(dirname(destination), { recursive: true });
run(
  "go",
  ["build", "-tags", "fts5", "-ldflags", "-s -w", "-o", destination, "."],
  {
    cwd: resolve("kernel"),
    env: { ...process.env, CGO_ENABLED: "1", GOOS: goos, GOARCH: goarch },
  },
);
console.log(`[noema-electron] Go kernel -> ${destination}`);
