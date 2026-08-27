import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

const projectRoot = resolve(".");
const output = resolve("build", "electron", "Noema.app");
const electronApp = resolve("node_modules", "electron", "dist", "Electron.app");

if (process.platform !== "darwin") {
  throw new Error("The linked Electron app assembler currently supports macOS");
}
if (!existsSync(electronApp)) {
  throw new Error("Electron runtime is missing; run npm run prepare:electron");
}

function link(source, destination, type = undefined) {
  mkdirSync(dirname(destination), { recursive: true });
  rmSync(destination, { recursive: true, force: true });
  symlinkSync(resolve(source), destination, type || (lstatSync(source).isDirectory() ? "dir" : "file"));
}

function cloneOrCopy(source, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  try {
    execFileSync("/bin/cp", ["-c", source, destination]);
    return "APFS-cloned";
  } catch {
    copyFileSync(source, destination);
    return "copied";
  }
}

function hardlinkTree(source, destination) {
  const entry = lstatSync(source);
  if (entry.isSymbolicLink()) {
    mkdirSync(dirname(destination), { recursive: true });
    symlinkSync(readlinkSync(source), destination);
    return;
  }
  if (entry.isDirectory()) {
    mkdirSync(destination, { recursive: true });
    for (const child of readdirSync(source)) hardlinkTree(join(source, child), join(destination, child));
    return;
  }
  mkdirSync(dirname(destination), { recursive: true });
  try {
    linkSync(source, destination);
  } catch {
    cloneOrCopy(source, destination);
  }
}

rmSync(output, { recursive: true, force: true });
const sourceContents = join(electronApp, "Contents");
const contents = join(output, "Contents");
const macos = join(contents, "MacOS");
const resources = join(contents, "Resources");
mkdirSync(macos, { recursive: true });
mkdirSync(resources, { recursive: true });

const executableMode = cloneOrCopy(join(sourceContents, "MacOS", "Electron"), join(macos, "Electron"));
for (const entry of readdirSync(join(sourceContents, "Resources"), { withFileTypes: true })) {
  if (entry.name === "default_app.asar" || entry.name === "electron.icns") continue;
  link(join(sourceContents, "Resources", entry.name), join(resources, entry.name), entry.isDirectory() ? "dir" : "file");
}
hardlinkTree(join(sourceContents, "Frameworks"), join(contents, "Frameworks"));
if (existsSync(join(sourceContents, "PkgInfo"))) copyFileSync(join(sourceContents, "PkgInfo"), join(contents, "PkgInfo"));
copyFileSync(join(sourceContents, "Info.plist"), join(contents, "Info.plist"));

const kernelArch = process.arch === "x64" ? "amd64" : process.arch;
const kernel = resolve("build", "kernel", `darwin-${kernelArch}`, "noema-kernel");
if (!existsSync(kernel)) throw new Error(`Built Go kernel is missing: ${kernel}`);

link(projectRoot, join(resources, "app"), "dir");
link(kernel, join(resources, "bin", "noema-kernel"), "file");
link(resolve("desktop", "Noema.icns"), join(resources, "electron.icns"), "file");

const plist = "/usr/libexec/PlistBuddy";
for (const [key, value] of [
  ["CFBundleDisplayName", "Noema"],
  // Keep Electron's internal executable/helper naming intact so Frameworks
  // can remain a single link instead of copying and rewriting every Helper.
  ["CFBundleExecutable", "Electron"],
  ["CFBundleIdentifier", "com.noema.desktop"],
  ["CFBundleIconFile", "electron.icns"],
  ["CFBundleName", "Electron"],
  ["CFBundleShortVersionString", "0.3.1"],
  ["CFBundleVersion", "0.3.1"],
]) {
  execFileSync(plist, ["-c", `Set :${key} ${value}`, join(contents, "Info.plist")]);
}
try {
  execFileSync(plist, ["-c", "Delete :CFBundleDocumentTypes", join(contents, "Info.plist")], { stdio: "ignore" });
} catch {}
for (const command of [
  "Add :CFBundleDocumentTypes array",
  "Add :CFBundleDocumentTypes:0 dict",
  "Add :CFBundleDocumentTypes:0:CFBundleTypeName string 'Markdown Document'",
  "Add :CFBundleDocumentTypes:0:CFBundleTypeRole string Editor",
  "Add :CFBundleDocumentTypes:0:LSHandlerRank string Alternate",
  "Add :CFBundleDocumentTypes:0:CFBundleTypeExtensions array",
  "Add :CFBundleDocumentTypes:0:CFBundleTypeExtensions:0 string md",
  "Add :CFBundleDocumentTypes:0:CFBundleTypeExtensions:1 string markdown",
]) execFileSync(plist, ["-c", command, join(contents, "Info.plist")]);

try {
  execFileSync(plist, ["-c", "Delete :CFBundleURLTypes", join(contents, "Info.plist")], { stdio: "ignore" });
} catch {}
for (const command of [
  "Add :CFBundleURLTypes array",
  "Add :CFBundleURLTypes:0 dict",
  "Add :CFBundleURLTypes:0:CFBundleURLName string com.noema.desktop.noema",
  "Add :CFBundleURLTypes:0:CFBundleTypeRole string Viewer",
  "Add :CFBundleURLTypes:0:CFBundleURLSchemes array",
  "Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string noema",
]) execFileSync(plist, ["-c", command, join(contents, "Info.plist")]);

console.log(`[noema-electron] ${executableMode} SiYuan-derived Electron shell with hard-linked Frameworks and linked app/kernel/icon -> ${output}`);
