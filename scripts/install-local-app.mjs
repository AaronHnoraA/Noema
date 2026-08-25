import { execFile } from "node:child_process";
import { copyFile, cp, link as hardlink, lstat, mkdir, mkdtemp, readlink, readdir, rename, rm, stat, symlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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
  const app = await lstat(bundle);
  const info = await stat(join(bundle, "Contents", "Info.plist"));
  let executable = null;
  for (const name of ["Noema", "Electron"]) {
    try {
      executable = await lstat(join(bundle, "Contents", "MacOS", name));
      break;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  if (!app.isDirectory() || !info.isFile() || !executable?.isFile()) {
    throw new Error(`Invalid Noema.app bundle: ${bundle}`);
  }
}

async function materializeLinkedEntry(source, destination) {
  const entry = await lstat(source);
  if (entry.isSymbolicLink()) {
    const target = await readlink(source);
    if (!isAbsolute(target)) {
      // Electron.framework uses relative Current/Resources/Helpers links. They
      // must stay relative so deleting the build staging bundle cannot break
      // the installed app. Repository/runtime links are absolute and keep
      // pointing at their single source of truth below.
      await symlink(target, destination);
      return;
    }
    const absoluteTarget = resolve(dirname(source), target);
    const targetEntry = await stat(source);
    await symlink(absoluteTarget, destination, targetEntry.isDirectory() ? "dir" : "file");
    return;
  }
  if (entry.isDirectory()) {
    await mkdir(destination, { recursive: true });
    for (const child of await readdir(source)) {
      await materializeLinkedEntry(join(source, child), join(destination, child));
    }
    return;
  }
  try {
    await hardlink(source, destination);
  } catch (error) {
    if (!new Set(["EXDEV", "EPERM", "ENOTSUP"]).has(error?.code)) throw error;
    await cp(source, destination, { force: false, preserveTimestamps: true });
  }
}

async function createLinkedAppShell(source, pending) {
  const sourceContents = join(source, "Contents");
  const pendingContents = join(pending, "Contents");
  const sourceMacOS = join(sourceContents, "MacOS");
  const pendingMacOS = join(pendingContents, "MacOS");
  let executableMode = "copied";
  await mkdir(pendingMacOS, { recursive: true });
  for (const entry of await readdir(sourceContents, { withFileTypes: true })) {
    if (entry.name === "MacOS") continue;
    await materializeLinkedEntry(
      join(sourceContents, entry.name),
      join(pendingContents, entry.name),
    );
  }
  for (const entry of await readdir(sourceMacOS, { withFileTypes: true })) {
    const sourceEntry = join(sourceMacOS, entry.name);
    const pendingEntry = join(pendingMacOS, entry.name);
    if (entry.name !== "Noema" && entry.name !== "Electron") {
      await materializeLinkedEntry(sourceEntry, pendingEntry);
      continue;
    }
    try {
      // A symlinked outer app loses shell-provided environment under macOS.
      // A hard link also lets LaunchServices collapse the
      // install back onto the source bundle. APFS clone gives the executable a
      // distinct identity while sharing its data blocks copy-on-write.
      if (process.platform !== "darwin") throw new Error("APFS clone is only available on macOS");
      await execFileAsync("/bin/cp", ["-c", sourceEntry, pendingEntry]);
      executableMode = "APFS-cloned";
    } catch {
      await rm(pendingEntry, { force: true });
      await copyFile(sourceEntry, pendingEntry);
    }
  }
  return executableMode;
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
  let executableMode = "copied";
  try {
    executableMode = await createLinkedAppShell(source, pending);
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
  const installedEntry = await lstat(destination);
  const linkedRuntimeEntries = [
    join(destination, "Contents", "Resources", "app"),
    join(destination, "Contents", "Resources", "node_modules"),
    join(destination, "Contents", "Frameworks"),
  ];
  let linkedRuntime = false;
  for (const entry of linkedRuntimeEntries) {
    try {
      if ((await lstat(entry)).isSymbolicLink()) linkedRuntime = true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const detail = linkedRuntime ? "; runtime dependencies remain linked" : "";
  const executableDetail = `; executable ${executableMode}`;
  const verb = installedEntry.isDirectory() ? "linked app shell" : "installed";
  console.log(`[noema-install] ${verb} ${destination} -> ${source}${executableDetail}${detail}`);
}

const invokedAsScript = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedAsScript) {
  const [source, destination, mode = "--link"] = process.argv.slice(2);
  if (!source || !destination) {
    throw new Error("Usage: node scripts/install-local-app.mjs SOURCE_APP DESTINATION_APP [--link]");
  }
  if (mode !== "--link") throw new Error(`Unknown install mode: ${mode}; local installation is link-only`);
  await installLocalApp(source, destination);
}
