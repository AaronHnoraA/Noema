import { posix, win32 } from "node:path";
import { realpathSync, statSync } from "node:fs";

export const NOEMA_PROTOCOL_SCHEME = "noema";
export const MAX_NOEMA_PROTOCOL_URL_BYTES = 16 * 1024;

const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const MARKDOWN_RE = /\.(?:md|markdown)$/i;
const OPEN_PARAMETERS = new Set(["path", "file", "hash", "dom", "disposition"]);
const ROUTE_PARAMETERS = new Set(["disposition"]);

function pathApi(platform = process.platform) {
  return platform === "win32" ? win32 : posix;
}

function protocolError(message) {
  return new Error(`Invalid Noema URL: ${message}`);
}

function boundedText(value, label, limit = 1024) {
  const source = String(value || "");
  if (CONTROL_RE.test(source)) throw protocolError(`${label} contains a control character`);
  const text = source.trim();
  if (text.length > limit) throw protocolError(`${label} is too long`);
  return text;
}

function decodedFragment(value) {
  const raw = String(value || "").replace(/^#/, "");
  if (!raw) return "";
  try {
    return boundedText(decodeURIComponent(raw), "hash");
  } catch (error) {
    if (String(error?.message || "").startsWith("Invalid Noema URL:")) throw error;
    throw protocolError("hash is not valid percent-encoding");
  }
}

function assertParameters(url, allowed) {
  const seen = new Set();
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) throw protocolError(`unsupported parameter: ${key}`);
    if (seen.has(key)) throw protocolError(`duplicate parameter: ${key}`);
    seen.add(key);
  }
}

function dispositionFrom(url) {
  const disposition = boundedText(url.searchParams.get("disposition"), "disposition", 16);
  if (disposition && disposition !== "new") {
    throw protocolError("disposition must be new when provided");
  }
  return disposition;
}

function hasHiddenSegment(file, platform) {
  const segments = platform === "win32"
    ? String(file).split(/[\\/]+/)
    : String(file).split(/\/+/);
  return segments.some((part) => part.startsWith(".") && part !== "." && part !== "..");
}

export function noemaProtocolUrlFromArgv(argv = []) {
  return Array.from(argv || [])
    .map((value) => String(value || "").trim())
    .find((value) => /^noema:/i.test(value)) || "";
}

export function protocolPathWithin(root, target, platform = process.platform) {
  const paths = pathApi(platform);
  const relative = paths.relative(paths.resolve(String(root || "")), paths.resolve(String(target || "")));
  return relative === "" || (!relative.startsWith(`..${paths.sep}`) && relative !== ".." && !paths.isAbsolute(relative));
}

export function parseNoemaProtocolUrl(value, options = {}) {
  const source = String(value || "");
  if (CONTROL_RE.test(source)) throw protocolError("URL contains a control character");
  const raw = source.trim();
  if (!raw) throw protocolError("URL is empty");
  if (Buffer.byteLength(raw, "utf8") > MAX_NOEMA_PROTOCOL_URL_BYTES) {
    throw protocolError("URL is too long");
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw protocolError("URL cannot be parsed");
  }
  if (url.protocol.toLowerCase() !== `${NOEMA_PROTOCOL_SCHEME}:`) {
    throw protocolError(`unsupported scheme: ${url.protocol || "unknown"}`);
  }
  if (url.username || url.password || url.port) throw protocolError("credentials and ports are not supported");
  if (url.pathname && url.pathname !== "/") throw protocolError("command paths are not supported");

  const command = url.hostname.toLowerCase();
  if (!command) throw protocolError("command is missing");
  if (command === "wiki" || command === "graph") {
    assertParameters(url, ROUTE_PARAMETERS);
    if (url.hash) throw protocolError("route fragments are not supported");
    return {
      action: "open-route",
      route: command === "graph" ? "/wiki?view=graph" : "/wiki",
      disposition: dispositionFrom(url),
    };
  }
  if (command !== "open") throw protocolError(`unsupported command: ${command}`);

  assertParameters(url, OPEN_PARAMETERS);
  const workspacePath = boundedText(url.searchParams.get("path"), "path", 4096);
  const absoluteFile = boundedText(url.searchParams.get("file"), "file", 4096);
  if (Boolean(workspacePath) === Boolean(absoluteFile)) {
    throw protocolError("provide exactly one of path or file");
  }
  const queryHash = boundedText(url.searchParams.get("hash"), "hash");
  const fragmentHash = decodedFragment(url.hash);
  if (queryHash && fragmentHash) throw protocolError("provide hash as a parameter or fragment, not both");
  const hash = queryHash || fragmentHash;
  const dom = boundedText(url.searchParams.get("dom"), "dom");
  if (hash && dom) throw protocolError("hash and dom cannot be combined");

  const platform = String(options.platform || process.platform);
  const paths = pathApi(platform);
  const workspaceRoot = boundedText(options.workspaceRoot, "workspace root", 4096);
  let file = "";
  let scope = "absolute";
  if (workspacePath) {
    if (!workspaceRoot) throw protocolError("workspace root is unavailable");
    if (paths.isAbsolute(workspacePath)) throw protocolError("path must be workspace-relative");
    if (hasHiddenSegment(workspacePath, platform)) throw protocolError("hidden paths are not supported");
    file = paths.resolve(workspaceRoot, workspacePath);
    if (!protocolPathWithin(workspaceRoot, file, platform)) throw protocolError("path escapes the workspace");
    scope = "workspace";
  } else {
    if (!paths.isAbsolute(absoluteFile)) throw protocolError("file must be absolute");
    if (hasHiddenSegment(absoluteFile, platform)) throw protocolError("hidden paths are not supported");
    file = paths.resolve(absoluteFile);
  }
  if (!MARKDOWN_RE.test(file)) throw protocolError("target must be a Markdown file");

  return {
    action: "open-note",
    file,
    scope,
    workspaceRoot: scope === "workspace" ? paths.resolve(workspaceRoot) : "",
    hash,
    dom,
    disposition: dispositionFrom(url),
  };
}

export function verifyNoemaProtocolTarget(target, options = {}) {
  if (!target || target.action !== "open-note") return target;
  const platform = String(options.platform || process.platform);
  const paths = pathApi(platform);
  const realpath = typeof options.realpath === "function" ? options.realpath : realpathSync;
  const stat = typeof options.stat === "function" ? options.stat : statSync;
  let file;
  try {
    file = realpath(target.file);
    if (!stat(file).isFile()) throw new Error("target is not a file");
  } catch {
    throw protocolError("target does not exist or is not a file");
  }
  if (!MARKDOWN_RE.test(file)) throw protocolError("canonical target is not Markdown");
  if (target.scope === "workspace") {
    let root;
    try { root = realpath(target.workspaceRoot); }
    catch { throw protocolError("workspace is unavailable"); }
    if (!protocolPathWithin(root, file, platform)) {
      throw protocolError("target escapes the workspace through a symbolic link");
    }
    if (hasHiddenSegment(paths.relative(root, file), platform)) {
      throw protocolError("canonical target is hidden");
    }
    return { ...target, file, workspaceRoot: root };
  }
  if (hasHiddenSegment(file, platform)) throw protocolError("canonical target is hidden");
  return { ...target, file };
}
