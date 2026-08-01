import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function powershellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export async function moveWindowsPathToRecycleBin(file, {
  kind = "",
  run = execFileAsync,
} = {}) {
  const target = resolve(String(file || ""));
  const pathKind = kind || ((await stat(target)).isDirectory() ? "directory" : "file");
  const method = pathKind === "directory" ? "DeleteDirectory" : "DeleteFile";
  const command = [
    "Add-Type -AssemblyName Microsoft.VisualBasic;",
    `[Microsoft.VisualBasic.FileIO.FileSystem]::${method}(`,
    `${powershellLiteral(target)},`,
    "[Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,",
    "[Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)",
  ].join(" ");
  await run("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-Command", command,
  ], { windowsHide: true });
  return target;
}

export async function createWindowsZip(sourceDirectory, outputFile, { run = execFileAsync } = {}) {
  const source = resolve(String(sourceDirectory || ""));
  const output = resolve(String(outputFile || ""));
  const command = [
    "Add-Type -AssemblyName System.IO.Compression.FileSystem;",
    "[System.IO.Compression.ZipFile]::CreateFromDirectory(",
    `${powershellLiteral(source)},`,
    `${powershellLiteral(output)})`,
  ].join(" ");
  await run("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-Command", command,
  ], { windowsHide: true });
  return output;
}
