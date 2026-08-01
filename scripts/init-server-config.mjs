import { constants } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const configDir = join(projectRoot, "server-config");

await mkdir(configDir, { recursive: true, mode: 0o700 });
for (const name of ["runtime", "deploy"]) {
  const source = join(projectRoot, "docs", `server-${name}.example.json`);
  const destination = join(configDir, `${name}.json`);
  try {
    await copyFile(source, destination, constants.COPYFILE_EXCL);
    process.stdout.write(`Created ${destination}\n`);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    process.stdout.write(`Kept existing ${destination}\n`);
  }
}
