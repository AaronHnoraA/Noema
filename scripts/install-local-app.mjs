import { cp, lstat, mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function validateApp(bundle) {
  const info = await stat(join(bundle, "Contents", "Info.plist"));
  const executable = await stat(join(bundle, "Contents", "MacOS", "Noema"));
  if (!info.isFile() || !executable.isFile()) {
    throw new Error(`Invalid Noema.app bundle: ${bundle}`);
  }
}

export async function installLocalApp(sourcePath, destinationPath) {
  const source = resolve(sourcePath);
  const destination = resolve(destinationPath);
  if (source === destination) throw new Error("Source and destination app paths must differ");
  await validateApp(source);
  await mkdir(dirname(destination), { recursive: true });

  const transaction = await mkdtemp(join(dirname(destination), `.${basename(destination)}.install-`));
  const pending = join(transaction, basename(destination));
  const previous = join(transaction, "previous.app");
  let movedPrevious = false;
  let installed = false;
  try {
    await cp(source, pending, {
      recursive: true,
      force: false,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
    await validateApp(pending);
    if (await pathExists(destination)) {
      await rename(destination, previous);
      movedPrevious = true;
    }
    try {
      await rename(pending, destination);
      installed = true;
    } catch (error) {
      if (movedPrevious) await rename(previous, destination);
      throw error;
    }
    if (movedPrevious) await rm(previous, { recursive: true, force: true });
  } finally {
    if (!installed && movedPrevious && !await pathExists(destination) && await pathExists(previous)) {
      await rename(previous, destination);
    }
    await rm(transaction, { recursive: true, force: true });
  }
  const runtime = await lstat(join(destination, "Contents", "Resources", "node_modules"));
  const detail = runtime.isSymbolicLink() ? "; runtime dependencies remain linked" : "";
  console.log(`[noema-install] installed ${destination} from ${source}${detail}`);
}

const invokedAsScript = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedAsScript) {
  const [source, destination] = process.argv.slice(2);
  if (!source || !destination) {
    throw new Error("Usage: node scripts/install-local-app.mjs SOURCE_APP DESTINATION_APP");
  }
  await installLocalApp(source, destination);
}
