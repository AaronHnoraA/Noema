import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";

const env = { ...process.env };

try {
  const cargo = execFileSync("rustup", ["which", "cargo", "--toolchain", "1.85.1"], { encoding: "utf8" }).trim();
  if (cargo) env.PATH = `${dirname(cargo)}${delimiter}${env.PATH || ""}`;
} catch {
  // A normal rustup proxy honors rust-toolchain.toml without this local-path aid.
}

if (process.platform === "darwin") {
  const supportsTarget = (stub, target) => {
    if (!existsSync(stub)) return false;
    const topLevelTargets = readFileSync(stub, "utf8").match(/^targets:\s*\[([\s\S]*?)\]/m)?.[1] || "";
    return topLevelTargets.split(/[\s,]+/).includes(target);
  };
  const activeSdk = execFileSync("xcrun", ["--show-sdk-path"], { encoding: "utf8" }).trim();
  const systemStub = join(activeSdk, "usr", "lib", "libSystem.B.tbd");
  let sdk = activeSdk;
  if (!supportsTarget(systemStub, "arm64-macos")) {
    const sdkRoot = dirname(activeSdk);
    const compatible = readdirSync(sdkRoot)
      .filter((name) => /^MacOSX\d+(?:\.\d+)?\.sdk$/.test(name))
      .map((name) => join(sdkRoot, name))
      .filter((candidate) => {
        const stub = join(candidate, "usr", "lib", "libSystem.B.tbd");
        return supportsTarget(stub, "arm64-macos");
      })
      .sort()
      .at(-1);
    if (compatible) sdk = compatible;
  }
  env.SDKROOT = sdk;
  env.RUSTFLAGS = `${env.RUSTFLAGS || ""} -C link-arg=-isysroot -C link-arg=${sdk}`.trim();
}

const executable = resolve("node_modules", ".bin", process.platform === "win32" ? "tauri.cmd" : "tauri");
const bundle = env.NOEMA_TAURI_BUNDLE || {
  darwin: "app",
  win32: "nsis",
  linux: "appimage",
}[process.platform];
if (!bundle) throw new Error(`No Tauri bundle target is configured for ${process.platform}`);
console.log(`[noema-tauri] building ${bundle} bundle for ${process.platform}`);
const linkedRuntime = process.platform === "darwin"
  && bundle === "app"
  && env.NOEMA_PORTABLE !== "1";
const buildArgs = ["build", "--bundles", bundle];
if (!linkedRuntime) {
  buildArgs.push(
    "--config",
    JSON.stringify({ bundle: { resources: { "../node_modules/": "node_modules/" } } }),
  );
  console.log("[noema-tauri] portable runtime: bundling node_modules");
}
const result = spawnSync(executable, buildArgs, { env, stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

if (linkedRuntime) {
  const targetRoot = resolve("src-tauri", "target");
  const releaseRoots = [join(targetRoot, "release")];
  for (const entry of readdirSync(targetRoot, { withFileTypes: true })) {
    if (entry.isDirectory()) releaseRoots.push(join(targetRoot, entry.name, "release"));
  }
  const apps = releaseRoots
    .map((releaseRoot) => join(releaseRoot, "bundle", "macos", "Noema.app"))
    .filter(existsSync);
  if (apps.length === 0) throw new Error("Tauri reported success but Noema.app was not found");
  const modules = resolve("node_modules");
  for (const app of apps) {
    const resources = join(app, "Contents", "Resources");
    const destination = join(resources, "node_modules");
    mkdirSync(resources, { recursive: true });
    rmSync(destination, { recursive: true, force: true });
    symlinkSync(modules, destination, "dir");
    console.log(`[noema-tauri] linked runtime ${destination} -> ${modules}`);
  }
}
