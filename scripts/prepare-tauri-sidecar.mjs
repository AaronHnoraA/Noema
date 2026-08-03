import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { copyFile, mkdir, chmod, readFile } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const triple = execFileSync("rustc", ["--print", "host-tuple"], { encoding: "utf8" }).trim();
if (!triple) throw new Error("rustc did not report a host target tuple");

const extension = process.platform === "win32" ? ".exe" : "";
const destination = resolve("src-tauri", "binaries", `noema-node-${triple}${extension}`);
const nodeVersion = "26.5.0";
const artifacts = {
  "darwin-arm64": ["node-v26.5.0-darwin-arm64.tar.gz", "ee920559aaa2391569cff4d737e3b83963430e3a14dedd91bfe0ff53171b5af9"],
  "darwin-x64": ["node-v26.5.0-darwin-x64.tar.gz", "98293394c945a24e64e00b4177bf075ec963ea70b34d1d2e24bd4a71716d334f"],
  "linux-arm64": ["node-v26.5.0-linux-arm64.tar.gz", "308e5fe89a82461ba5a6cf15ff5221b2cdbd7ae87600aa72bb3c3fbdc66412d1"],
  "linux-x64": ["node-v26.5.0-linux-x64.tar.gz", "22b5f47ad6ae78837e4c2b846019965ce1a06ba143de176102294a1bf44fc677"],
  "win32-arm64": ["win-arm64/node.exe", "4d817169241b9b37ec5b88617dcfed6a8f8f8640c57eaf15b54c3b8b118e9be4"],
  "win32-x64": ["win-x64/node.exe", "119d6fa70e6ae1b15b90688ab6bcc8e3a2819acea021af196895cab1843645af"],
};
const artifact = artifacts[`${process.platform}-${process.arch}`];
if (!artifact) throw new Error(`No official Node sidecar is configured for ${process.platform}-${process.arch}`);

const [artifactName, expectedHash] = artifact;
const cacheRoot = join(tmpdir(), `noema-node-v${nodeVersion}`);
const archive = join(cacheRoot, artifactName.replaceAll("/", "-"));
await mkdir(cacheRoot, { recursive: true });

async function validCache() {
  try {
    return createHash("sha256").update(await readFile(archive)).digest("hex") === expectedHash;
  } catch {
    return false;
  }
}

if (!await validCache()) {
  const response = await fetch(`https://nodejs.org/dist/v${nodeVersion}/${artifactName}`);
  if (!response.ok || !response.body) throw new Error(`Node sidecar download failed: ${response.status} ${response.statusText}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(archive, { mode: 0o600 }));
  if (!await validCache()) throw new Error(`Node sidecar checksum mismatch for ${artifactName}`);
}

let source = archive;
if (artifactName.endsWith(".tar.gz")) {
  const extractRoot = join(cacheRoot, artifactName.replace(/\.tar\.gz$/, ""));
  await mkdir(extractRoot, { recursive: true });
  const extracted = spawnSync("tar", ["-xzf", archive, "--strip-components=2", "-C", extractRoot, `node-v${nodeVersion}-${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch}/bin/node`], { stdio: "inherit" });
  if (extracted.status !== 0) throw new Error(`Unable to extract ${artifactName}`);
  source = join(extractRoot, "node");
}

await mkdir(dirname(destination), { recursive: true });
await copyFile(source, destination);
if (process.platform !== "win32") await chmod(destination, 0o755);
console.log(`[noema-tauri] official Node v${nodeVersion} sidecar -> ${destination}`);
