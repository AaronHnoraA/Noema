import { lstat, mkdir, mkdtemp, readlink, realpath, rename, rm, stat, symlink } from "node:fs/promises";
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

async function alreadyLinked(destination, source) {
  try {
    const info = await lstat(destination);
    if (!info.isSymbolicLink()) return false;
    const target = resolve(dirname(destination), await readlink(destination));
    return await realpath(target) === await realpath(source);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function installLinkedApp(sourcePath, destinationPath) {
  const source = resolve(sourcePath);
  const destination = resolve(destinationPath);
  if (source === destination) throw new Error("Source and destination app paths must differ");
  await validateApp(source);
  await mkdir(dirname(destination), { recursive: true });

  if (await alreadyLinked(destination, source)) {
    console.log(`[noema-install] already linked ${destination} -> ${source}`);
    return;
  }

  const transaction = await mkdtemp(join(dirname(destination), `.${basename(destination)}.install-`));
  const pending = join(transaction, basename(destination));
  const previous = join(transaction, "previous.app");
  let movedPrevious = false;
  let installed = false;
  try {
    await symlink(source, pending, process.platform === "win32" ? "junction" : "dir");
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
  console.log(`[noema-install] linked ${destination} -> ${source}`);
}

const invokedAsScript = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedAsScript) {
  const [source, destination] = process.argv.slice(2);
  if (!source || !destination) {
    throw new Error("Usage: node scripts/install-local-app.mjs SOURCE_APP DESTINATION_APP");
  }
  await installLinkedApp(source, destination);
}
