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
  "dist/pages",
  "src/styles/themes",
  // The Go kernel is built on the server (scripts/deploy-server.mjs): its
  // source and the resources it runs from travel with the release.
  "kernel",
  "kernel-resources",
];

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
for (const entry of entries) {
  const destination = join(outputRoot, entry);
  await mkdir(dirname(destination), { recursive: true });
  await cp(join(projectRoot, entry), destination, {
    recursive: true,
    force: true,
    // Test binaries and fixtures stay home; a kernel built for this Mac never
    // ships.
    filter: (source) => basename(source) !== ".DS_Store"
      && !source.endsWith(".test")
      && basename(source) !== "testdata",
  });
}
process.stdout.write(`Server release staged at ${outputRoot}\n`);
