import { accessSync, constants, existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const macVSCodeCli = "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code";
const macVSCodeInsidersCli = "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code";

function executable(file) {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function pathExecutable(name, pathValue = process.env.PATH || "") {
  for (const directory of String(pathValue).split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    if (executable(candidate)) return candidate;
  }
  return "";
}

export function findVSCodeCli(env = process.env) {
  const explicit = String(env.NOEMA_VSCODE || env.AARONNOTE_VSCODE || "").trim();
  if (explicit && executable(explicit)) return explicit;
  return pathExecutable("code", env.PATH)
    || (executable(macVSCodeCli) ? macVSCodeCli : "")
    || (executable(macVSCodeInsidersCli) ? macVSCodeInsidersCli : "");
}

export function vscodeOpenCommand({
  file,
  line = 1,
  col = 0,
  cli = "",
  platform = process.platform,
} = {}) {
  const safeFile = resolve(String(file || ""));
  const safeLine = Math.max(1, Math.floor(Number(line) || 1));
  const safeColumn = Math.max(1, Math.floor(Number(col) || 0) + 1);
  const target = `${safeFile}:${safeLine}:${safeColumn}`;
  if (cli) {
    return { command: cli, args: ["--new-window", "--goto", target] };
  }
  if (platform === "darwin") {
    return {
      command: "/usr/bin/open",
      args: ["-na", "Visual Studio Code", "--args", "--new-window", "--goto", target],
    };
  }
  return { command: "", args: [] };
}

export async function taggedSourceLocation(file, tag, fallbackLine = 1, fallbackCol = 0) {
  const cleanTag = String(tag || "").trim();
  if (!cleanTag) return { line: fallbackLine, col: fallbackCol };
  const marker = new RegExp(
    `^[ \\t]*(?:--|#|//|;)[ \\t]*@(?:aaronnote|note-code)[ \\t]+${cleanTag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*$`,
  );
  try {
    const lines = String(await readFile(file, "utf8")).split(/\r?\n/);
    const index = lines.findIndex((line) => marker.test(line));
    return index >= 0 ? { line: index + 1, col: 0 } : { line: fallbackLine, col: fallbackCol };
  } catch {
    return { line: fallbackLine, col: fallbackCol };
  }
}

export async function openInVSCode(body = {}, {
  env = process.env,
  run = execFileAsync,
} = {}) {
  const raw = body && typeof body === "object" ? body.file : body;
  const file = resolve(String(raw || ""));
  if (!raw || !isAbsolute(file) || !existsSync(file)) {
    return { ok: false, file, message: `File not found: ${file}` };
  }
  try {
    if (!statSync(file).isFile()) return { ok: false, file, message: `Not a file: ${file}` };
  } catch (error) {
    return { ok: false, file, message: error instanceof Error ? error.message : String(error) };
  }
  const position = await taggedSourceLocation(file, body?.tag, body?.line, body?.col);
  const spec = vscodeOpenCommand({
    file,
    line: position.line,
    col: position.col,
    cli: findVSCodeCli(env),
  });
  if (!spec.command) {
    return { ok: false, file, message: "VS Code command not found. Set NOEMA_VSCODE to the code executable." };
  }
  try {
    await run(spec.command, spec.args, { cwd: dirname(file) });
    return { ok: true, editor: "vscode", newWindow: true, file, ...position };
  } catch (error) {
    return { ok: false, file, message: error instanceof Error ? error.message : String(error) };
  }
}
