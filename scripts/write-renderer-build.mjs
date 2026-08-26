import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const receiptFile = resolve("dist", "aaronnote", ".noema-renderer-build.json");
const temporary = `${receiptFile}.${process.pid}.tmp`;
const receipt = {
  version: 1,
  generation: `${Date.now()}-${randomUUID()}`,
  builtAt: new Date().toISOString(),
};

await mkdir(dirname(receiptFile), { recursive: true });
await writeFile(temporary, `${JSON.stringify(receipt)}\n`, "utf8");
await rename(temporary, receiptFile);
process.stdout.write(`[noema-renderer] build ${receipt.generation}\n`);
