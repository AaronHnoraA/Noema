import { cp, mkdir, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outputRoot = join(projectRoot, "build", "server");
const entries = [
  "web-host.mjs",
  "package.json",
  "package-lock.json",
  "README.md",
  "LICENSE",
  "NOTICE",
  "server",
  "shared",
  "resources",
  "js",
  "dist/aaronnote",
  "src/styles/themes",
];

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
for (const entry of entries) {
  const destination = join(outputRoot, entry);
  await mkdir(dirname(destination), { recursive: true });
  await cp(join(projectRoot, entry), destination, {
    recursive: true,
    force: true,
    filter: (source) => basename(source) !== ".DS_Store",
  });
}
process.stdout.write(`Server release staged at ${outputRoot}\n`);
