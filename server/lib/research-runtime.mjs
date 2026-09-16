import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { notebookSource } from "./jupyter-notebook-format.mjs";
import { parseResearchDirectives } from "./research-directives.mjs";
import {
  installProjectSkill,
  prepareProjectSkill,
  assertRunnableCapabilities,
  mutateProjectCapability,
  projectCapabilityConfig,
  resolveProjectCapabilities,
  resolvedMCPServersForRun,
  resolvedSkillsForRun,
} from "./noema-capabilities.mjs";
import {
  deriveSessionRoute,
  parseSessionDirective,
  PI_SESSION_NAME,
  SESSION_KEYWORDS,
  validateSessionName,
} from "./research-session-routing.mjs";
import {
  createResearchCell,
  isResearchDocumentPath,
  readResearchNotebookFile,
  researchCellKind,
  researchError,
  researchMeta,
  researchWorkNodeForCell,
  researchWorkNodeId,
  researchWorkNodeSummary,
  validateResearchNotebook,
} from "./research-notebook.mjs";

const CONTEXT_LIMIT_BYTES = 64 * 1024;
const COMPACTION_CHECKPOINT_MAX_BYTES = 16 * 1024;
const RUN_ARTIFACT_MAX_BYTES = 8 * 1024 * 1024;
const RUN_ARTIFACT_MAX_FILES = 5000;
const ROUTING_RUN_WINDOW = 1000;
const RUN_ARTIFACT_MAX_CHANGES = 32;
// Files of one directory are stat'ed concurrently, in bounded chunks.
const SNAPSHOT_STAT_CONCURRENCY = 64;
// Runtime state, agent-shell transcripts and Pi's own directory are never
// work products of a Run (D-035).
const RUN_ARTIFACT_IGNORED_DIRECTORIES = new Set([
  ".agent", ".agent-shell", ".pi", ".git", "node_modules", "dist", "build", ".cache", ".venv", "__pycache__",
]);
// A `.noema' document changes during a Run only by Noema's own writers or the
// person's edits; it is the work record, not an artifact of the work.
const RUN_ARTIFACT_IGNORED_EXTENSIONS = Object.freeze([".noema"]);
const execFileAsync = promisify(execFile);

function capabilityScope(body) {
  const scope = body.scope ?? "project";
  if (scope !== "global" && scope !== "project") {
    throw researchError("Capability scope must be global or project", 400, "ERR_NOEMA_CAPABILITY_SCOPE");
  }
  return scope;
}

// Work inside the project runs without asking; the kernel broker approves it.
// Reaching outside the project or the network asks a person in Attention, and
// credentials and privilege elevation are always refused.
const DEFAULT_CAPABILITIES = Object.freeze({
  read_project: "allow",
  write_project: "allow",
  execute: "allow",
  network: "ask",
  write_outside_project: "ask",
  credentials: "deny",
});

const AGENT_COMMANDS = Object.freeze({
  codex: "codex-acp",
  claude: "claude-agent-acp",
  "claude-code": "claude-agent-acp",
  opencode: "opencode acp",
  "open-code": "opencode acp",
  pi: "pi-acp",
  magent: "magent-in-process",
});

const MANUAL_TUI_COMMANDS = Object.freeze({
  codex: (id) => ["codex", "resume", id],
  claude: (id) => ["claude", "--resume", id],
  "claude-code": (id) => ["claude", "--resume", id],
  opencode: (id) => ["opencode", "--session", id],
  "open-code": (id) => ["opencode", "--session", id],
});

export function manualTUICommand(session) {
  const adapter = valueString(session?.adapter).toLowerCase();
  const nativeID = valueString(session?.nativeSessionId ?? session?.native_session_id);
  const build = MANUAL_TUI_COMMANDS[adapter];
  if (valueString(session?.transport) !== "acp" || !nativeID || !build) {
    throw researchError(`Session adapter ${adapter || "unknown"} has no verified ACP-to-PTY handoff`, 422, "ERR_RESEARCH_TAKEOVER");
  }
  return build(nativeID);
}

function normalizeCapabilities(...sources) {
  const merged = Object.assign({}, ...sources.map(object));
  const aliases = {
    read_project: ["read_project", "projectRead"],
    write_project: ["write_project", "projectWrite"],
    execute: ["execute"],
    network: ["network"],
    write_outside_project: ["write_outside_project", "writeOutsideProject"],
    credentials: ["credentials"],
  };
  return Object.fromEntries(Object.entries(aliases).map(([canonical, names]) => {
    const selected = names.find((name) => Object.hasOwn(merged, name));
    return [canonical, selected ? merged[selected] : DEFAULT_CAPABILITIES[canonical]];
  }));
}

function agentDescriptor(agent, body) {
  const id = valueString(agent).toLowerCase();
  const frozen = object(object(body.adapterSnapshots ?? body.adapter_snapshots)[id]);
  return {
    id,
    transport: "acp",
    command: valueString(frozen.command) || AGENT_COMMANDS[id] || id,
    version: valueString(frozen.version) || "unknown",
  };
}

function hasDeniedCapability(capabilities) {
  return Object.values(object(capabilities)).some((value) => valueString(value) === "deny");
}

// Pi exposes ACP permission callbacks but has no project-root L1 confinement.
// A Run with a hard deny therefore needs an explicitly supplied external
// sandbox.  Other supported ACP adapters were validated with their native
// read-only/plan mode and are checked again by the Emacs worker before prompt.
function assertCapabilityEnvelope(agent, capabilities, body, executor = {}) {
  const name = valueString(agent).toLowerCase();
  const externalSandbox = Boolean(body.externalSandbox ?? body.external_sandbox ?? executor.external_sandbox);
  if (name === "pi" && hasDeniedCapability(capabilities) && !externalSandbox) {
    throw researchError("Pi cannot enforce denied capabilities without an external sandbox", 422, "ERR_RESEARCH_CAPABILITY");
  }
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function containsLocalDisclosure(value, seen = new Set()) {
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => containsLocalDisclosure(item, seen));
  for (const [key, nested] of Object.entries(value)) {
    if (key.replaceAll("_", "").toLowerCase() === "disclosure" && valueString(nested) === "local_only") return true;
    if (containsLocalDisclosure(nested, seen)) return true;
  }
  return false;
}

function valueString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function values(value) {
  return Array.isArray(value) ? value : [];
}

function proposalDocument(payload, key) {
  const source = object(payload);
  return Object.keys(object(source[key])).length ? object(source[key]) : source;
}

function proposedCellId(clientRequestId) {
  return `c-prop-${sha256(valueString(clientRequestId)).slice(0, 20)}`;
}

function sameStringList(left, right) {
  const normalize = (value) => [...new Set(values(value).map(valueString).filter(Boolean))].sort();
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function sameJSONObject(left, right) {
  const normalize = (value) => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])]));
    }
    return value;
  };
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function materializedCellMatches(notebook, cell, spec) {
  if (!cell || valueString(cell.id) !== valueString(spec.cellId || spec.cell_id)) return false;
  const node = researchWorkNodeForCell(notebook, cell);
  const kind = valueString(spec.kind) || "work";
  const lineageParent = valueString(spec.lineageParent || spec.lineage_parent);
  const expectedLineage = lineageParent ? [researchWorkNodeId(notebook, lineageParent)].filter(Boolean) : [];
  const expectedDepends = values(spec.depends).map((id) => researchWorkNodeId(notebook, id)).filter(Boolean);
  const summary = node ? researchWorkNodeSummary(notebook, node.id) : null;
  return researchCellKind(cell, notebook) === kind
    && valueString(node?.title) === valueString(spec.title)
    && notebookSource(cell.source) === notebookSource(spec.source ?? "")
    && sameStringList(summary?.lineage, expectedLineage)
    && sameStringList(summary?.depends, expectedDepends);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function pathIsInside(root, path) {
  const part = relative(root, path);
  return part === "" || (!part.startsWith(`..${sep}`) && part !== ".." && !isAbsolute(part));
}

async function snapshotProjectFiles(root) {
  const snapshot = new Map();
  const walk = async (directory) => {
    if (snapshot.size >= RUN_ARTIFACT_MAX_FILES) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    // Every Run takes this snapshot before dispatch, so a directory's files are
    // stat'ed concurrently.  Insertion still follows the sorted walk order.
    let pending = [];
    const flush = async () => {
      const batch = pending;
      pending = [];
      for (let start = 0; start < batch.length; start += SNAPSHOT_STAT_CONCURRENCY) {
        const chunk = batch.slice(start, start + SNAPSHOT_STAT_CONCURRENCY);
        // Concurrent file removal is normal during an agent Run.
        const infos = await Promise.all(chunk.map((path) => stat(path).catch(() => null)));
        chunk.forEach((path, index) => {
          const info = infos[index];
          if (!info || snapshot.size >= RUN_ARTIFACT_MAX_FILES) return;
          snapshot.set(relative(root, path).split(sep).join("/"), { size: info.size, mtimeMs: info.mtimeMs });
        });
      }
    };
    for (const entry of entries) {
      if (snapshot.size + pending.length >= RUN_ARTIFACT_MAX_FILES) break;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await flush();
        if (!RUN_ARTIFACT_IGNORED_DIRECTORIES.has(entry.name)) await walk(join(directory, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      if (RUN_ARTIFACT_IGNORED_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) continue;
      pending.push(join(directory, entry.name));
    }
    await flush();
  };
  await walk(root);
  return snapshot;
}

function fileArtifactURI(relativePath) {
  return `noema://file/${relativePath.split("/").map(encodeURIComponent).join("/")}`;
}

async function detectRunFileArtifacts({ root, run, before, provider }) {
  if (!(before instanceof Map) || typeof provider?.importArtifact !== "function") return { drafts: [], errors: [] };
  const after = await snapshotProjectFiles(root);
  const changed = [...after.entries()].filter(([path, info]) => {
    const prior = before.get(path);
    return !prior || prior.size !== info.size || prior.mtimeMs !== info.mtimeMs;
  }).slice(0, RUN_ARTIFACT_MAX_CHANGES);
  const drafts = [];
  const errors = [];
  for (const [path, info] of changed) {
    if (info.size <= 0 || info.size > RUN_ARTIFACT_MAX_BYTES) continue;
    try {
      const bytes = await readFile(join(root, ...path.split("/")));
      if (bytes.byteLength <= 0 || bytes.byteLength > RUN_ARTIFACT_MAX_BYTES) continue;
      const change = before.has(path) ? "modified" : "created";
      const artifact = await provider.importArtifact({ root, artifact: {
        kind: "run-file",
        mediaType: contentMediaType(path),
        contentBase64: bytes.toString("base64"),
        workstreamId: valueString(run.workstreamId),
        runId: valueString(run.id),
        sourceUri: fileArtifactURI(path),
        metadata: {
          path,
          change,
          run_id: valueString(run.id),
          work_node_id: valueString(run.workNodeId),
          notebook_id: valueString(run.notebookId),
          cell_id: valueString(run.cellId),
        },
      }});
      drafts.push({ type: "run.artifact.detected", payload: {
        artifact_id: valueString(artifact?.id),
        path,
        change,
        work_node_id: valueString(run.workNodeId),
      }});
    } catch (error) {
      errors.push({ path, message: String(error?.message || error) });
    }
  }
  return { drafts, errors };
}

async function projectFile(root, value) {
  const requested = String(value || "").trim();
  if (!requested) throw researchError("Context file reference is empty", 422, "ERR_RESEARCH_CONTEXT");
  const realRoot = await realpath(root);
  const path = await realpath(resolve(root, requested));
  if (!pathIsInside(realRoot, path)) {
    throw researchError("Context file escapes the project", 403, "ERR_RESEARCH_CONTEXT");
  }
  return { path, root: realRoot, relative: relative(realRoot, path).split(sep).join("/") };
}

async function projectDirectory(root, value) {
  const candidate = await projectFile(root, value || root);
  if (!(await stat(candidate.path)).isDirectory()) {
    throw researchError("Execution target must be an existing project directory", 422, "ERR_RESEARCH_TARGET");
  }
  return candidate.path;
}

async function projectIdentity(root) {
  const manifest = await readFile(join(root, "noema.toml"), "utf8");
  const match = /^\s*repository_id\s*=\s*["']([^"']+)["']\s*$/m.exec(manifest);
  if (!match?.[1]?.trim()) throw researchError("noema.toml lacks repository_id", 422, "ERR_RESEARCH_PROJECT_ID");
  return match[1].trim();
}

function contentMediaType(path = "") {
  const lower = String(path).toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "text/markdown; charset=utf-8";
  if (lower.endsWith(".json") || lower.endsWith(".ipynb")) return "application/json";
  if (lower.endsWith(".el") || lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".ts") || lower.endsWith(".go")) {
    return "text/plain; charset=utf-8";
  }
  return "application/octet-stream";
}

function asContextItem({ ref, resolvedUri, bytes, mediaType, truncated = false }) {
  const content = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return {
    ref,
    resolvedUri,
    mediaType,
    contentBase64: content.toString("base64"),
    truncated: Boolean(truncated),
  };
}

// Automatic context is truncated only while at least this much room is left;
// a smaller fragment helps nobody and is omitted instead.
const AUTO_CONTEXT_MIN_TRUNCATED_BYTES = 1024;

function boundedContextItem(item, maxBytes, note = "compacted checkpoint truncated at 16 KiB") {
  const bytes = Buffer.from(item.contentBase64, "base64");
  if (bytes.byteLength <= maxBytes) return item;
  const marker = Buffer.from(`\n\n[Noema: ${note}]\n`);
  const prefixLimit = Math.max(0, maxBytes - marker.byteLength);
  let prefix = bytes.subarray(0, prefixLimit).toString("utf8").replace(/\uFFFD$/, "");
  while (Buffer.byteLength(prefix) > prefixLimit) prefix = prefix.slice(0, -1);
  const bounded = Buffer.concat([Buffer.from(prefix), marker]);
  return {
    ...item,
    contentBase64: bounded.toString("base64"),
    truncated: true,
  };
}

function publicContextItem(item) {
  const bytes = Buffer.from(item.contentBase64, "base64");
  return {
    ref: item.ref,
    resolved_uri: item.resolvedUri,
    sha256: sha256(bytes),
    bytes: bytes.byteLength,
    truncated: item.truncated,
  };
}

function checkDisclosure(cell, notebook = null) {
  const node = notebook ? researchWorkNodeForCell(notebook, cell) : null;
  if (valueString(node?.disclosure || researchMeta(cell).disclosure) === "local_only") {
    throw researchError("A local_only research cell cannot be injected into a Run", 403, "ERR_RESEARCH_DISCLOSURE");
  }
}

export function parseResearchPrompt(text) {
  return parseResearchDirectives(text, {
    allowWorkstream: true,
    allowLegacySingleAt: true,
    allowAgenda: false,
    sourceName: ".prompt file",
  });
}

function resultForWork(notebook, workId) {
  const target = researchWorkNodeId(notebook, workId);
  const matches = (notebook.cells || []).filter((cell) => researchCellKind(cell, notebook) === "result"
    && valueString(researchMeta(cell).work_node_id) === target);
  return matches.at(-1) || null;
}

function mimeText(value) {
  if (Array.isArray(value)) return value.join("");
  return typeof value === "string" ? value : "";
}

function latestOutputForWork(notebook, workId) {
  const target = researchWorkNodeId(notebook, workId);
  const workCell = (notebook.cells || []).find((cell) => (
    cell?.cell_type === "code" && valueString(researchMeta(cell).work_node_id) === target
  ));
  for (const output of [...values(workCell?.outputs)].reverse()) {
    const data = object(output?.data);
    const text = mimeText(data["text/markdown"]) || mimeText(data["text/plain"]);
    if (!text) continue;
    const run = object(data["application/vnd.noema.run+json"]);
    return { cell: workCell, text, runId: valueString(run.run_id), agent: valueString(run.agent), status: valueString(run.status), legacy: false };
  }
  const legacy = resultForWork(notebook, target);
  return legacy ? {
    cell: legacy,
    text: notebookSource(legacy.source),
    runId: valueString(researchMeta(legacy).run_id),
    agent: valueString(researchMeta(legacy).agent),
    status: valueString(researchMeta(legacy).status),
    legacy: true,
  } : null;
}

function cellById(notebook, id) {
  return (notebook.cells || []).find((cell) => cell?.id === id) || null;
}

/** Describe where a new conversation runs: project root, document and block. */
function projectContextItem({ root, source }) {
  const title = valueString(researchWorkNodeForCell(source.notebook, source.cell)?.title);
  const lines = [
    "# Noema project",
    "",
    `- Project root and working directory: ${root}`,
    `- Research document: ${source.file} (${join(root, source.file)})`,
    `- Work block: ${title || source.cellId}`,
    "",
    "Relative paths are relative to the project root. The research document holds the question and work this request belongs to; attached upstream blocks give its context.",
    "For local files, use filesystem tools from this working directory. Research document/cell IDs are not knowledge-base notebook IDs; use Noema knowledge tools only when the task needs that store.",
    "Attached context is already supplied: do not fetch it again unless missing or stale. Read only what the task requires; when asked to read all files, read each relevant file once, continuing at the next unread offset for paginated files.",
    "",
  ];
  return asContextItem({
    ref: "project",
    resolvedUri: `noema://project/${encodeURIComponent(source.notebookId)}`,
    bytes: lines.join("\n"),
    mediaType: "text/markdown; charset=utf-8",
  });
}

function contextRef(entry) {
  if (typeof entry === "string") {
    const ref = entry.trim();
    const lineage = /^lineage:([1-3])$/.exec(ref);
    return lineage ? { ref: "lineage", depth: Number(lineage[1]) } : { ref };
  }
  const value = object(entry);
  const nested = contextRef(valueString(value.ref));
  return { ref: nested.ref, depth: value.depth ?? nested.depth, auto: value.auto === true };
}

/**
 * Fit automatically attached context into what the declared context leaves.
 * Declared context stays a hard 64 KiB contract; automatic items (marked
 * `auto`) are kept whole in priority order while they fit; the ones that do
 * not are truncated into a useful remainder or omitted and reported, instead of
 * failing a Run nobody configured (D-036).
 */
function fitAutomaticContext(items, limit = CONTEXT_LIMIT_BYTES) {
  const size = (item) => Buffer.from(item.contentBase64, "base64").byteLength;
  const required = items.filter((item) => !item.auto).reduce((sum, item) => sum + size(item), 0);
  if (required > limit) {
    throw researchError("Declared Run context exceeds 64 KiB; narrow the explicit references", 422, "ERR_RESEARCH_CONTEXT_LIMIT");
  }
  let remaining = limit - required;
  const plain = items.map(({ auto: _auto, ...item }) => item);
  const chosen = items.map((item, index) => (item.auto ? undefined : plain[index]));
  // Whole items first, in priority order, so one large output cannot push out
  // every small item after it; then cut what still waits into the remainder.
  items.forEach((item, index) => {
    if (item.auto && size(plain[index]) <= remaining) {
      remaining -= size(plain[index]);
      chosen[index] = plain[index];
    }
  });
  const omitted = [];
  items.forEach((item, index) => {
    if (!item.auto || chosen[index]) return;
    if (remaining >= AUTO_CONTEXT_MIN_TRUNCATED_BYTES) {
      chosen[index] = boundedContextItem(plain[index], remaining, "automatic context truncated to fit the Run context budget");
      remaining -= size(chosen[index]);
    } else {
      chosen[index] = null;
      omitted.push({ ref: plain[index].ref, resolved_uri: plain[index].resolvedUri, bytes: size(plain[index]), reason: "context budget" });
    }
  });
  return { items: chosen.filter(Boolean), omitted };
}

async function resolveContextItems({ root, notebook, sourceCell, declared, provider, sessionId, resolveKnowledgeNote }) {
  const notebookMeta = notebook ? researchMeta({ metadata: notebook.metadata }) : {};
  const notebookId = valueString(notebookMeta.notebook_id);
  const output = [];
  const seen = new Set();
  let total = 0;
  // Automatic entries are resolved after every declared one, so a declared
  // reference always owns content both would attach.
  let automatic = false;
  const append = (item) => {
    const bytes = Buffer.from(item.contentBase64, "base64");
    const key = JSON.stringify([item.resolvedUri, item.mediaType, sha256(bytes)]);
    if (seen.has(key)) return;
    seen.add(key);
    if (automatic) {
      output.push({ ...item, auto: true });
      return;
    }
    total += bytes.byteLength;
    if (total > CONTEXT_LIMIT_BYTES) {
      throw researchError("Declared Run context exceeds 64 KiB; narrow the explicit references", 422, "ERR_RESEARCH_CONTEXT_LIMIT");
    }
    output.push(item);
  };
  const cellItem = (cell, ref) => {
    if (!cell) throw researchError(`Unknown research context cell: ${ref}`, 404, "ERR_RESEARCH_CONTEXT");
    checkDisclosure(cell, notebook);
    const title = valueString(researchWorkNodeForCell(notebook, cell)?.title || researchMeta(cell).title);
    const source = notebookSource(cell.source);
    return asContextItem({
      ref,
      resolvedUri: `noema://cell/${encodeURIComponent(notebookId)}/${encodeURIComponent(cell.id)}`,
      bytes: `${title ? `# ${title}\n\n` : ""}${source}`,
      mediaType: "text/markdown; charset=utf-8",
    });
  };
  const outputItem = (workId, ref) => {
    const output = latestOutputForWork(notebook, workId);
    if (!output) throw researchError(`No work output exists for ${ref}`, 404, "ERR_RESEARCH_CONTEXT");
    checkDisclosure(output.cell, notebook);
    return asContextItem({
      ref,
      resolvedUri: `noema://work-output/${encodeURIComponent(notebookId)}/${encodeURIComponent(researchWorkNodeId(notebook, workId) || workId)}${output.runId ? `/${encodeURIComponent(output.runId)}` : ""}`,
      bytes: output.text,
      mediaType: "text/markdown; charset=utf-8",
    });
  };
  const lineage = (depth) => {
    const maxDepth = Number(depth ?? 1);
    if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 3) {
      throw researchError("lineage context depth must be an integer from 1 through 3", 422, "ERR_RESEARCH_CONTEXT");
    }
    const seen = new Set();
    const walk = (cell, remaining) => {
      if (!cell || remaining <= 0) return;
      const node = researchWorkNodeForCell(notebook, cell);
      if (!node) return;
      for (const parentId of researchWorkNodeSummary(notebook, node.id).lineage) {
        const parentNode = researchWorkNodeSummary(notebook, parentId);
        const parent = parentNode.primaryCellId ? cellById(notebook, parentNode.primaryCellId) : null;
        if (!parent || seen.has(parent.id)) continue;
        seen.add(parent.id);
        if (["question", "work", "checkpoint"].includes(researchCellKind(parent, notebook))) append(cellItem(parent, `cell:${parent.id}`));
        walk(parent, remaining - 1);
      }
    };
    walk(sourceCell, maxDepth);
  };
  const dependencies = () => {
    const node = researchWorkNodeForCell(notebook, sourceCell);
    for (const workId of (node ? researchWorkNodeSummary(notebook, node.id).depends : [])) {
      if (latestOutputForWork(notebook, workId)) append(outputItem(workId, `result:${workId}`));
    }
  };
  const entries = values(declared).map(contextRef);
  for (const { ref, depth, auto } of [...entries.filter((entry) => !entry.auto), ...entries.filter((entry) => entry.auto)]) {
    automatic = Boolean(auto);
    if (!ref) throw researchError("Context entries need a ref", 422, "ERR_RESEARCH_CONTEXT");
    // `none' only switches automatic context off; prepareRun honours it.
    if (ref === "none") continue;
    if (ref === "lineage") {
      if (!notebook || !sourceCell) throw researchError("lineage context is only valid in a research notebook", 422, "ERR_RESEARCH_CONTEXT");
      lineage(depth);
      continue;
    }
    if (ref === "depends") {
      if (!notebook || !sourceCell) throw researchError("depends context is only valid in a research notebook", 422, "ERR_RESEARCH_CONTEXT");
      dependencies();
      continue;
    }
    if (ref.startsWith("cell:")) {
      if (!notebook) throw researchError(`${ref} is only valid in a research notebook`, 422, "ERR_RESEARCH_CONTEXT");
      append(cellItem(cellById(notebook, ref.slice("cell:".length)), ref));
      continue;
    }
    if (ref.startsWith("result:")) {
      if (!notebook) throw researchError(`${ref} is only valid in a research notebook`, 422, "ERR_RESEARCH_CONTEXT");
      append(outputItem(ref.slice("result:".length), ref));
      continue;
    }
    if (ref.startsWith("file:")) {
      const file = await projectFile(root, ref.slice("file:".length));
      append(asContextItem({
        ref,
        resolvedUri: `noema://file/${file.relative.split("/").map(encodeURIComponent).join("/")}`,
        bytes: await readFile(file.path),
        mediaType: contentMediaType(file.path),
      }));
      continue;
    }
    if (ref.startsWith("note:")) {
      const id = ref.slice("note:".length).trim();
      if (!id || typeof resolveKnowledgeNote !== "function") {
        throw researchError(`Knowledge note context is unavailable: ${ref}`, 503, "ERR_RESEARCH_CONTEXT");
      }
      const note = object(await resolveKnowledgeNote(id, root));
      if (valueString(note.disclosure) === "local_only") {
        throw researchError(`A local_only knowledge note cannot be injected: ${ref}`, 403, "ERR_RESEARCH_DISCLOSURE");
      }
      const content = String(note.content || "");
      if (!content) throw researchError(`Knowledge note has no readable content: ${ref}`, 404, "ERR_RESEARCH_CONTEXT");
      append(asContextItem({
        ref,
        resolvedUri: valueString(note.uri) || `noema://note/${encodeURIComponent(id)}`,
        bytes: content,
        mediaType: valueString(note.mediaType) || "text/markdown; charset=utf-8",
      }));
      continue;
    }
    if (ref.startsWith("artifact:")) {
      const id = ref.slice("artifact:".length).trim();
      if (!id.startsWith("art_")) throw researchError(`Invalid artifact context: ${ref}`, 422, "ERR_RESEARCH_CONTEXT");
      const stored = await provider.readArtifact({ root, id });
      const bytes = Buffer.from(valueString(stored.dataBase64), "base64");
      if (!bytes.length) throw researchError(`Artifact has no readable bytes: ${ref}`, 404, "ERR_RESEARCH_CONTEXT");
      append(asContextItem({ ref, resolvedUri: `noema://artifact/${encodeURIComponent(id)}`, bytes,
        mediaType: valueString(stored.artifact?.mediaType) || "application/octet-stream" }));
      continue;
    }
    if (ref === "handoff.latest") {
      if (!sessionId) throw researchError("handoff.latest requires a routed Session", 422, "ERR_RESEARCH_CONTEXT");
      const latest = await latestParentHandoff(provider, root, sessionId);
      if (!latest.item) throw researchError("The routed Session has no Handoff artifact", 404, "ERR_RESEARCH_CONTEXT");
      append({ ...latest.item, ref });
      continue;
    }
    if (ref === "git.diff") {
      let stdout;
      try {
        ({ stdout } = await execFileAsync("git", ["-C", root, "diff", "--no-ext-diff", "--binary", "HEAD", "--"], {
          encoding: "buffer", maxBuffer: CONTEXT_LIMIT_BYTES + 1,
        }));
      } catch (error) {
        if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          throw researchError("git.diff context exceeds 64 KiB", 422, "ERR_RESEARCH_CONTEXT_LIMIT");
        }
        throw researchError(`Cannot freeze git.diff context: ${error?.message || error}`, 422, "ERR_RESEARCH_CONTEXT");
      }
      const bytes = Buffer.from(stdout);
      append(asContextItem({ ref, resolvedUri: `noema://git/diff/${sha256(bytes)}`, bytes, mediaType: "text/x-diff; charset=utf-8" }));
      continue;
    }
    throw researchError(`Unsupported v1 context reference: ${ref}`, 422, "ERR_RESEARCH_CONTEXT");
  }
  return output;
}

async function latestParentHandoff(provider, root, sessionId, workNodeId = "") {
  // A re-run or branch reconstructs from the upstream block's own Run, never
  // from a later attempt that happens to share the conversation.
  const sessionRuns = await provider.runs({ root, sessionId, limit: 200 });
  const runs = workNodeId
    ? values(sessionRuns).filter((run) => valueString(run?.workNodeId ?? run?.work_node_id) === workNodeId)
    : values(sessionRuns);
  const handoffItem = async (run, artifactId) => {
    const stored = await provider.readArtifact({ root, id: artifactId });
    return {
      run,
      item: asContextItem({
        ref: `handoff:${run.id}`,
        resolvedUri: `noema://artifact/${encodeURIComponent(artifactId)}`,
        bytes: Buffer.from(valueString(stored.dataBase64), "base64"),
        mediaType: valueString(stored.artifact?.mediaType) || "text/markdown; charset=utf-8",
      }),
    };
  };
  for (const run of runs) {
    if (!valueString(run?.id)) continue;
    if (typeof provider.runHandoff === "function") {
      // The kernel reads only the Run's status events; streamed content of a
      // long Run is never paged just to find its Handoff.
      const artifactId = valueString((await provider.runHandoff({ root, id: run.id }))?.handoffArtifactId);
      if (artifactId) return handoffItem(run, artifactId);
      continue;
    }
    let after = 0;
    for (;;) {
      const live = await provider.liveRun({ root, id: run.id, after, limit: 1000 });
      const events = values(live.events);
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const artifactId = valueString(events[index]?.payload?.handoff_artifact_id);
        if (!artifactId) continue;
        const stored = await provider.readArtifact({ root, id: artifactId });
        return {
          run,
          item: asContextItem({
            ref: `handoff:${run.id}`,
            resolvedUri: `noema://artifact/${encodeURIComponent(artifactId)}`,
            bytes: Buffer.from(valueString(stored.dataBase64), "base64"),
            mediaType: valueString(stored.artifact?.mediaType) || "text/markdown; charset=utf-8",
          }),
        };
      }
      const next = Number(live.seq) || after;
      if (events.length < 1000 || next <= after) break;
      after = next;
    }
  }
  return { run: runs[0] || null, item: null };
}

async function existingDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export async function findResearchProjectRoot(start) {
  let current = resolve(String(start || ""));
  try {
    if (!(await stat(current)).isDirectory()) current = dirname(current);
  } catch {
    throw researchError(`Research project path does not exist: ${current}`, 404, "ERR_RESEARCH_ROOT");
  }
  for (;;) {
    try {
      if ((await stat(join(current, "noema.toml"))).isFile()) return current;
    } catch {
      // Walk to the filesystem root.
    }
    const parent = dirname(current);
    if (parent === current) {
      throw researchError(`No noema.toml found above ${start}`, 404, "ERR_RESEARCH_ROOT");
    }
    current = parent;
  }
}

export async function defaultResearchHistorySources(projectRoot, { userHome = homedir(), env = process.env } = {}) {
  const candidates = [
    { kind: "agent-shell", path: join(projectRoot, ".agent-shell", "transcripts") },
    { kind: "magent", path: join(userHome, ".config", "emacs", "var", "noema-interaction", "magent", "sessions") },
    { kind: "codex", path: join(String(env.CODEX_HOME || join(userHome, ".codex")), "sessions") },
    { kind: "claude", path: join(userHome, ".claude", "projects") },
  ];
  const available = [];
  for (const source of candidates) {
    if (await existingDirectory(source.path)) available.push({ ...source, projectRoot });
  }
  return available;
}

export function createResearchRuntimeService({
  getProvider = () => null,
  getNotebookService = () => null,
	getJupyterService = () => null,
  getRuntimeDescriptor = () => null,
  defaultRoot = "",
  resolveKnowledgeNote = null,
  historySources = defaultResearchHistorySources,
  deliverWorkerCommand = () => false,
	spawnProjectProcess = spawn,
} = {}) {
  const runFileBaselines = new Map();
  // A baseline normally ends with its Run's terminal worker event.  Runs that
  // end elsewhere (cancelled before dispatch, failed while preparing, or
  // interrupted by lease expiry) forget theirs there; this sweep bounds what a
  // vanished worker leaves in a long-lived host.
  const RUN_FILE_BASELINE_TTL_MS = 24 * 60 * 60 * 1000;
  const forgetRunFileBaseline = (runId) => runFileBaselines.delete(valueString(runId));
  const sweepRunFileBaselines = (now = Date.now()) => {
    for (const [runId, baseline] of [...runFileBaselines]) {
      if (now - Number(baseline?.createdAt || 0) > RUN_FILE_BASELINE_TTL_MS) runFileBaselines.delete(runId);
    }
  };
	const localRunProcesses = new Map();
	const localEventQueues = new Map();
	const cacheMaintenanceAt = new Map();
	const writebackDrains = new Map();
	const writebackRetryTimers = new Map();
	const writebackRecoveryRoots = new Set();
  const provider = () => {
    const value = getProvider();
    if (!value) throw researchError("kernel research runtime is unavailable", 503, "ERR_RESEARCH_INDEX");
    return value;
  };
  const rootFor = async (body) => {
    const candidate = String(body.root || body.cwd || body.executionTarget || body.file || body.promptFile || body.prompt_file || defaultRoot || "").trim();
    if (!candidate || !isAbsolute(candidate)) {
      throw researchError("A project root or absolute cwd is required", 400, "ERR_RESEARCH_ROOT");
    }
	const root = await findResearchProjectRoot(candidate);
	if (!writebackRecoveryRoots.has(root)) {
	  writebackRecoveryRoots.add(root);
	  const timer = setTimeout(() => {
		void drainNotebookWritebacks(root).catch(() => {});
		void maybeMaintainCache(root).catch(() => {});
	  }, 0);
	  timer.unref?.();
	}
	return root;
  };
	const maybeMaintainCache = async (root, force = false) => {
	  const runtimeProvider = provider();
	  if (typeof runtimeProvider.maintainCache !== "function") return null;
	  const now = Date.now();
	  if (!force && now - Number(cacheMaintenanceAt.get(root) || 0) < 60 * 60 * 1000) return null;
	  cacheMaintenanceAt.set(root, now);
	  return runtimeProvider.maintainCache({ root });
	};
	const writebackDelay = (attempts) => [1_000, 2_000, 5_000, 10_000, 30_000, 60_000, 300_000][Math.min(6, Math.max(0, Number(attempts) - 1))];
	const scheduleWritebackDrain = (root, delay) => {
	  const prior = writebackRetryTimers.get(root);
	  if (prior) clearTimeout(prior);
	  const timer = setTimeout(() => {
		writebackRetryTimers.delete(root);
		void drainNotebookWritebacks(root).catch(() => {});
	  }, Math.max(250, Number(delay) || 1_000));
	  timer.unref?.();
	  writebackRetryTimers.set(root, timer);
	};
  const leaseChecks = new Map();
  async function repairRunOutput(root, run) {
    forgetRunFileBaseline(run?.id);
    const runtime = provider();
    if (!run?.cellId || !run?.notebookId || !runtime.resolveCell || !runtime.queueNotebookWriteback) return null;
    if (runtime.runs) {
      const latest = (await runtime.runs({ root, workstreamId: run.workstreamId, limit: 1000 }))
        .find((candidate) => candidate.notebookId === run.notebookId && candidate.cellId === run.cellId);
      if (latest && latest.id !== run.id) return { skipped: "newer-run" };
    }
    const cell = await runtime.resolveCell({ root, notebookId: run.notebookId, cellId: run.cellId });
    const file = await projectFile(root, valueString(cell?.path));
    let content = "";
    let terminalText;
    let after = 0;
    if (runtime.liveRun) {
      for (;;) {
        const page = await runtime.liveRun({ root, id: run.id, after, limit: 200 });
        const events = values(page.events);
        for (const event of events) {
          if (event.type === "run.content.segment" && event.payload?.stream === "assistant") {
            content = (content + String(event.payload.text || "")).slice(0, 256 * 1024);
          }
          if (event.type === "run.status.changed" && typeof event.payload?.result_text === "string") {
            terminalText = event.payload.result_text;
          }
        }
        const next = Number(page.seq) || 0;
        if (events.length < 200 || next <= after) break;
        after = next;
      }
    }
    await runtime.queueNotebookWriteback({ root, writeback: {
      runId: run.id, notebookPath: file.relative, cellId: run.cellId,
      output: { notebookId: run.notebookId, workId: run.workNodeId || run.cellId,
        agent: valueString(run.agent), status: run.status,
        content: terminalText ?? (content || `Run ${run.status}. ${run.failureReason || ""}`.trim()) },
    } });
    let completed = await drainNotebookWritebacks(root);
    if (!completed.has(run.id)) completed = await drainNotebookWritebacks(root);
    return completed.get(run.id) || null;
  }

  async function refreshExpiredLeases(root, force = false) {
    if (!provider().expireLeases) return;
    const previous = leaseChecks.get(root);
    if (previous?.pending) return previous.pending;
    if (!force && previous && Date.now() - previous.at < 5000) return;
    const entry = { at: Date.now(), pending: null };
    leaseChecks.set(root, entry);
    entry.pending = (async () => {
      const result = await provider().expireLeases({ root });
      for (const run of values(result?.interrupted)) {
        // Expired authority means interrupted, not inferred successful output.
        await repairRunOutput(root, run).catch(() => {});
      }
    })();
    try { await entry.pending; } finally { entry.pending = null; }
  }

	async function drainNotebookWritebacks(root) {
	  if (writebackDrains.has(root)) return writebackDrains.get(root);
	  const operation = (async () => {
		const runtimeProvider = provider();
		if (typeof runtimeProvider.claimNotebookWritebacks !== "function") return new Map();
		const completed = new Map();
		for (const item of await runtimeProvider.claimNotebookWritebacks({ root })) {
		  const output = object(item.output);
		  try {
			const file = await projectFile(root, valueString(item.notebookPath));
			const notebooks = getNotebookService();
			const writeRunOutput = notebooks?.writeRunOutput?.bind(notebooks)
			  || notebooks?.writeRunResult?.bind(notebooks);
			if (!writeRunOutput) throw researchError("research notebook writer is unavailable", 503, "ERR_RESEARCH_RESULT");
			const result = await writeRunOutput({
			  file: file.path,
			  notebookId: valueString(output.notebookId),
			  workId: valueString(output.workId),
			  cellId: valueString(item.cellId),
			  runId: valueString(item.runId),
			  agent: valueString(output.agent),
			  status: valueString(output.status),
			  content: String(output.content || ""),
			  actor: "worker",
			});
			await runtimeProvider.completeNotebookWriteback({ root, writeback: { runId: item.runId, state: "done" } });
			deliverWorkerCommand({ type: "notebook-writeback", root, file: file.path, runId: item.runId });
			completed.set(valueString(item.runId), result);
		  } catch (error) {
			const conflict = Number(error?.statusCode || error?.status) === 409;
			const delay = writebackDelay(item.attempts);
			await runtimeProvider.completeNotebookWriteback({ root, writeback: {
			  runId: item.runId, state: conflict ? "conflict" : "failed",
			  lastError: String(error?.message || error), retryAfterMillis: conflict ? 0 : delay,
			} });
			completed.set(valueString(item.runId), { error: String(error?.message || error), pending: !conflict });
			if (!conflict) scheduleWritebackDrain(root, delay);
		  }
		}
		return completed;
	  })();
	  writebackDrains.set(root, operation);
	  try {
		return await operation;
	  } finally {
		writebackDrains.delete(root);
	  }
	}
	// Emacs sends the ratio its context warning uses (D-036); anything
	// outside a sane range falls back to the D-035 default.
	const rolloverRatio = (body) => {
	  const ratio = Number(body?.contextRolloverRatio ?? body?.context_rollover_ratio);
	  return Number.isFinite(ratio) && ratio >= 0.5 && ratio <= 0.99 ? ratio : 0.85;
	};
	async function compactRouteIfNeeded(root, route, body = {}, { dryRun = false } = {}) {
	  const runtimeProvider = provider();
	  const sessionId = valueString(route.sessionId);
	  if (!sessionId || !["continued", "selected"].includes(valueString(route.mode))
		  || typeof runtimeProvider.sessionContext !== "function") return route;
	  const context = await runtimeProvider.sessionContext({ root, sessionId });
	  const usage = object(context.usage);
	  const size = Number(usage.contextSize) || 0;
	  const ratio = size > 0 ? (Number(usage.contextUsed) || 0) / size : 0;
	  let compaction = object(context.compaction);
	  if (!valueString(compaction.id) && ratio >= rolloverRatio(body)) {
		// A preview reports the rollover the next Run would request without
		// creating a pending compaction.
		if (dryRun) compaction = { id: "preview", status: "preview" };
		else if (typeof runtimeProvider.requestSessionCompaction === "function") {
		  compaction = object(await runtimeProvider.requestSessionCompaction({ root, sessionId }));
		}
	  }
	  if (!valueString(compaction.id)) return route;
	  return {
		...route,
		policy: "fork",
		sessionId: "",
		mode: "fork-reconstructed",
		parentSessionId: sessionId,
		parent: route.session,
		compaction,
		reason: `context rollover from ${Math.round(ratio * 100)}%; rebuilt from the latest durable handoff`,
	  };
	}

  async function sourceForRun(root, body, preview = null) {
    const file = valueString(body.file);
    const promptFile = valueString(body.promptFile || body.prompt_file);
	const projectFileRef = valueString(body.projectFile || body.project_file);
	if (promptFile && (file || projectFileRef)) throw researchError("A Run has one source, not both a prompt and a project file", 422, "ERR_RESEARCH_RUN");
	if (projectFileRef && !file) throw researchError("A project-file Run requires its owning .noema file and work cell", 422, "ERR_RESEARCH_RUN");
    if (file) {
      const loaded = preview || await readResearchNotebookFile(file);
      const loadedRoot = await findResearchProjectRoot(loaded.file);
      if (resolve(loadedRoot) !== resolve(root)) throw researchError("Research notebook is outside the selected project", 403, "ERR_RESEARCH_ROOT");
      const cellId = valueString(body.cellId || body.cell_id);
      const cell = cellById(loaded.notebook, cellId);
      const workNode = cell ? researchWorkNodeForCell(loaded.notebook, cell) : null;
      if (!cell || cell.cell_type !== "code" || researchCellKind(cell, loaded.notebook) !== "work" || workNode?.kind !== "work") {
        throw researchError("Document execution requires an existing work cell", 422, "ERR_RESEARCH_WORK_CELL");
      }
      checkDisclosure(cell, loaded.notebook);
      const notebookMeta = researchMeta({ metadata: loaded.notebook.metadata });
      const workstreamId = valueString(notebookMeta.workstream_id);
      const notebookId = valueString(notebookMeta.notebook_id);
      if (!workstreamId || !notebookId) throw researchError("Research notebook lacks durable identity", 422, "ERR_RESEARCH_FORMAT");
      const directives = parseResearchDirectives(notebookSource(cell.source), { sourceName: `work cell ${cellId}` });
	  if (projectFileRef) {
		const executable = await projectFile(root, projectFileRef);
		const lower = executable.relative.toLowerCase();
		if (!lower.endsWith(".py") && !lower.endsWith(".ipynb")) {
		  throw researchError("Project-file execution supports .py and .ipynb files", 422, "ERR_RESEARCH_PROJECT_FILE");
		}
		if (!(await stat(executable.path)).isFile()) {
		  throw researchError("Project-file execution requires an existing file", 422, "ERR_RESEARCH_PROJECT_FILE");
		}
		const bytes = await readFile(executable.path);
		return {
		  kind: "project-file", workstreamId, notebookId, cellId, workNodeId: workNode.id,
		  file: relative(root, loaded.file).split(sep).join("/"), projectFile: executable.relative,
		  projectPath: executable.path, projectSHA256: `sha256:${sha256(bytes)}`,
		  projectType: lower.endsWith(".ipynb") ? "jupyter" : "python",
		  prompt: "", cell, notebook: loaded.notebook,
		  executor: { ...object(researchMeta(cell).executor) }, context: [],
		  sourceRef: `noema://file/${executable.relative.split("/").map(encodeURIComponent).join("/")}`,
		  notebookRevision: loaded.revision,
		  cellSourceSHA256: `sha256:${sha256(notebookSource(cell.source))}`,
		};
	  }
      return {
        kind: "work-cell",
        workstreamId,
        notebookId,
        cellId,
        workNodeId: workNode.id,
        file: relative(root, loaded.file).split(sep).join("/"),
        prompt: directives.prompt,
        cell,
        notebook: loaded.notebook,
        executor: {
          ...object(researchMeta(cell).executor),
          agent: directives.agent,
          session_policy: directives.session,
          skills: directives.skills,
        },
        defaultAgent: valueString(notebookMeta.default_agent),
        context: directives.context,
        sourceRef: `noema://cell/${encodeURIComponent(notebookId)}/${encodeURIComponent(cellId)}`,
        notebookRevision: loaded.revision,
        cellSourceSHA256: `sha256:${sha256(notebookSource(cell.source))}`,
      };
    }
    if (promptFile) {
      const prompt = await projectFile(root, promptFile);
      if (!prompt.relative.toLowerCase().endsWith(".prompt")) {
		throw researchError("Prompt-file execution requires a .prompt file", 422, "ERR_RESEARCH_PROMPT");
      }
      const parsed = parseResearchPrompt(await readFile(prompt.path, "utf8"));
      const requestedWorkstream = valueString(body.workstreamId || body.workstream_id);
      if (requestedWorkstream && parsed.workstreamId && requestedWorkstream !== parsed.workstreamId) {
        throw researchError("Requested workstream conflicts with the .prompt directive", 422, "ERR_RESEARCH_PROMPT");
      }
      const workstreamId = requestedWorkstream || parsed.workstreamId;
      if (!workstreamId.startsWith("ws_")) {
        throw researchError("A prompt-file Run requires an existing workstreamId", 422, "ERR_RESEARCH_WORKSTREAM");
      }
      return {
        kind: "prompt-file",
        workstreamId,
        notebookId: "",
        cellId: "",
        workNodeId: "",
        file: prompt.relative,
        prompt: parsed.prompt,
        cell: null,
        notebook: null,
        executor: { ...object(body.executor), agent: parsed.agent || object(body.executor).agent, skills: parsed.skills },
        defaultAgent: "",
        directiveSession: parsed.session,
        context: parsed.context,
        sourceRef: `noema://file/${prompt.relative.split("/").map(encodeURIComponent).join("/")}`,
        notebookRevision: "",
        cellSourceSHA256: `sha256:${sha256(parsed.prompt)}`,
      };
    }
    throw researchError("Run preparation needs file + cellId or promptFile", 422, "ERR_RESEARCH_RUN");
  }

  async function sessionNamesFor(root) {
    const runtimeProvider = provider();
    return typeof runtimeProvider.sessionNames === "function"
      ? values(await runtimeProvider.sessionNames({ root }))
      : [];
  }

  // Routing reads the newest Runs.  A project with a longer history also reads
  // each WorkNode's latest conversation Run, so work that last ran long ago
  // still continues its own conversation instead of silently branching (D-036).
  async function routingRunsFor(root) {
    const runtimeProvider = provider();
    if (typeof runtimeProvider.runs !== "function") return [];
    const recent = values(await runtimeProvider.runs({ root, limit: ROUTING_RUN_WINDOW }));
    if (recent.length < ROUTING_RUN_WINDOW) return recent;
    const seen = new Set(recent.map((run) => valueString(run?.id)));
    const older = values(await runtimeProvider.runs({ root, latestPerWorkNode: true }).catch(() => []))
      .filter((run) => valueString(run?.id) && !seen.has(valueString(run.id)))
      .sort((left, right) => String(right?.createdAt || "").localeCompare(String(left?.createdAt || "")));
    return [...recent, ...older];
  }

  // JuText previews routes on idle after edits.  Consecutive previews within a
  // moment share one kernel snapshot; a Run never uses this cache, and any Run
  // or name change drops it (D-036).
  const PREVIEW_SNAPSHOT_TTL_MS = 2000;
  const previewSnapshots = new Map();
  const forgetPreviewSnapshot = (root) => previewSnapshots.delete(root);
  function previewRoutingSnapshot(root) {
    const cached = previewSnapshots.get(root);
    if (cached && Date.now() - cached.at < PREVIEW_SNAPSHOT_TTL_MS) return cached.pending;
    const pending = Promise.all([sessionNamesFor(root), routingRunsFor(root)]);
    previewSnapshots.set(root, { at: Date.now(), pending });
    pending.catch(() => { if (previewSnapshots.get(root)?.pending === pending) previewSnapshots.delete(root); });
    return pending;
  }

  // D-031: every conversation a work block reaches has a project-scoped name.
  // An explicit directive wins, then a coordinator-requested name, then the
  // lineage-derived default.  Explicit session/parent ids from older callers
  // keep their original route.
  async function routeRun(root, source, target, body, { dryRun = false, snapshot = null } = {}) {
    let agent = valueString(source.executor.agent);
    const rawDirective = valueString(source.directiveSession || source.executor.session_policy)
      || valueString(body.sessionPolicy || body.session_policy);
    const directive = parseSessionDirective(rawDirective);
    const explicitIds = valueString(body.sessionId || body.session_id)
      || valueString(body.parentSessionId || body.parent_session_id);
    if (explicitIds || (source.kind === "prompt-file" && directive.kind !== "name" && directive.kind !== "fork")) {
      const keyword = SESSION_KEYWORDS.includes(rawDirective) ? rawDirective : "";
      return legacyRouteRun(root, { ...source, directiveSession: keyword,
        executor: { ...source.executor, session_policy: keyword } }, target, { ...body, sessionPolicy: keyword });
    }
    const runtimeProvider = provider();
    const [names, runs] = snapshot || await Promise.all([sessionNamesFor(root), routingRunsFor(root)]);
    const decision = deriveSessionRoute({
      notebook: source.notebook, workNodeId: source.workNodeId, agent,
      defaultAgent: valueString(source.defaultAgent) || valueString(body.agent || body.adapter || object(body.executor).agent), directive,
      requestedName: valueString(body.sessionName || body.session_name), runs: values(runs), names,
    });
    agent = decision.agent;
    const byName = new Map();
    for (const entry of names) {
      byName.set(valueString(entry.name), entry);
      for (const alias of values(entry.aliases)) byName.set(valueString(alias), entry);
    }
    const intent = { name: decision.name, agent, parentName: decision.parentName, forkMode: decision.forkMode, origin: decision.origin };
    const base = {
      agent, sessionName: intent, autoContext: decision.autoContext,
      derivation: { rule: decision.rule, from_work_node: decision.fromWorkNodeId, reason: decision.reason },
    };
    const onTarget = async (session) => {
      try {
        return (await projectDirectory(root, session.executionTarget)) === target;
      } catch {
        return false;
      }
    };
    const fresh = (reason) => ({ ...base, policy: "fresh", sessionId: "", mode: "fresh", reason });

    if (decision.action === "adopt") {
      const sessions = await runtimeProvider.sessions({ root, workstreamId: source.workstreamId, adapter: agent, limit: 200 });
      const legacy = values(sessions).find((candidate) => valueString(candidate.id) === decision.legacySessionId);
      if (legacy && ["active", "warm"].includes(legacy.state) && await onTarget(legacy)) {
        return { ...base, policy: "continue", sessionId: legacy.id, mode: "continued", session: legacy };
      }
      return fresh("no resumable same-agent session");
    }
    if (decision.action === "rebind") {
      // A re-run keeps the block's own session name under a new generation.
      const rebound = { ...base, sessionName: { ...intent, parentName: "", forkMode: "" } };
      const upstreamEntry = decision.parentName ? byName.get(decision.parentName) : null;
      if (upstreamEntry && valueString(upstreamEntry.sessionId)) {
        const parent = await runtimeProvider.session({ root, id: upstreamEntry.sessionId });
        if (!(await onTarget(parent))) {
          throw researchError(`Session ${upstreamEntry.name} belongs to another execution target`, 422, "ERR_RESEARCH_SESSION");
        }
        return { ...rebound, policy: "continue", sessionId: "", mode: "fork-reconstructed", parentSessionId: parent.id, parent,
          reconstructFromWorkNode: decision.fromWorkNodeId, reason: `${decision.reason}; the earlier attempt is not inherited` };
      }
      return { ...rebound, policy: "fresh", sessionId: "", mode: "fresh", reason: decision.reason };
    }
    let action = decision.action;
    let parentName = decision.parentName;
    if (action === "continue") {
      const entry = byName.get(decision.name);
      if (entry && valueString(entry.sessionId)) {
        if (entry.openRun && !dryRun) {
          throw researchError(`Session ${entry.name} is busy with another Run`, 409, "ERR_RESEARCH_SESSION_BUSY");
        }
        const session = await runtimeProvider.session({ root, id: entry.sessionId });
        if (!(await onTarget(session))) {
          throw researchError(`Session ${entry.name} belongs to another execution target`, 422, "ERR_RESEARCH_SESSION");
        }
        if (["active", "warm"].includes(valueString(session.state))) {
          return { ...base, policy: "continue", sessionId: session.id, mode: "continued", session, busy: Boolean(entry.openRun) };
        }
        // The native conversation is gone; keep the name and rebuild from
        // its latest Handoff instead of pretending it survived.
        return { ...base, policy: "continue", sessionId: "", mode: "fork-reconstructed", parentSessionId: session.id,
          parent: session, reason: `session ${entry.name} was ${session.state}; rebuilt from its Handoff` };
      }
      if (entry && valueString(entry.parentName)) {
        action = "fork";
        parentName = valueString(entry.parentName);
      } else {
        return fresh(decision.reason);
      }
    }
    if (action === "fork") {
      const parentEntry = byName.get(parentName);
      if (!parentEntry || !valueString(parentEntry.sessionId)) {
        return fresh(`${parentName} has no conversation yet; started fresh`);
      }
      const parent = await runtimeProvider.session({ root, id: parentEntry.sessionId });
      if (!(await onTarget(parent))) {
        throw researchError(`Session ${parentEntry.name} belongs to another execution target`, 422, "ERR_RESEARCH_SESSION");
      }
      const native = decision.allowNative && object(parent.capabilities).sessionFork === true
        && valueString(parent.nativeSessionId) && valueString(parent.adapter) === agent;
      return {
        ...base, sessionName: { ...intent, parentName: parentEntry.name, forkMode: native ? "native" : "reconstructed" },
        policy: "fork", sessionId: "", mode: native ? "fork" : "fork-reconstructed", parentSessionId: parent.id, parent,
        reconstructFromWorkNode: decision.fromWorkNodeId,
        reason: native ? decision.reason : `${decision.reason}; no hidden parent conversation is inherited`,
      };
    }
    return fresh(decision.reason);
  }

  async function legacyRouteRun(root, source, target, body) {
    const requestedPolicy = valueString(source.directiveSession || source.executor.session_policy || body.sessionPolicy || body.session_policy);
    let policy = requestedPolicy;
    if (!["continue", "fork", "fresh"].includes(policy)) {
      if (policy) throw researchError(`Unsupported session policy: ${policy}`, 422, "ERR_RESEARCH_SESSION_POLICY");
    }
    const agent = valueString(source.executor.agent)
      || valueString(source.defaultAgent)
      || valueString(body.agent || body.adapter || object(body.executor).agent)
      || "codex";
    let priorRuns = null;
    const runsForSource = async () => {
      if (priorRuns) return priorRuns;
      const runtimeProvider = provider();
      const runs = typeof runtimeProvider.runs === "function"
        ? await runtimeProvider.runs({ root, workstreamId: source.workstreamId, limit: 200 })
        : [];
      priorRuns = runs.filter((run) => (
        source.workNodeId
          ? valueString(run.workNodeId || run.work_node_id) === source.workNodeId
          : valueString(run.sourceKind || run.source_kind) === source.kind
            && valueString(run.cellId || run.cell_id) === source.cellId
      ));
      return priorRuns;
    };
    if (!policy) {
      policy = (await runsForSource()).length > 0 ? "continue" : "fresh";
    }
    const requested = valueString(body.sessionId || body.session_id);
    if (requested) {
      const session = await provider().session({ root, id: requested });
      const sessionTarget = await projectDirectory(root, session.executionTarget);
      if (session.workstreamId !== source.workstreamId || sessionTarget !== target || valueString(session.adapter) !== agent) {
        throw researchError("Requested session does not match this workstream and execution target", 422, "ERR_RESEARCH_SESSION");
      }
      return { agent, policy, sessionId: requested, mode: "selected", session };
    }
    if (policy === "fresh") return { agent, policy, sessionId: "", mode: "fresh", reason: "explicit fresh policy" };
    if (policy === "fork") {
      let parentSessionId = valueString(body.parentSessionId || body.parent_session_id);
      if (!parentSessionId) {
        const candidates = await provider().sessions({ root, workstreamId: source.workstreamId, adapter: agent, limit: 200 });
        const eligible = source.workNodeId
          ? (await runsForSource()).map((run) => candidates.find((candidate) => (
            valueString(candidate.id) === valueString(run.sessionId || run.session_id)
          ))).filter(Boolean)
          : candidates;
        for (const candidate of eligible) {
          if (!["active", "warm"].includes(candidate.state)) continue;
          try {
            if ((await projectDirectory(root, candidate.executionTarget)) === target) {
              parentSessionId = valueString(candidate.id);
              break;
            }
          } catch {}
        }
      }
      if (!parentSessionId) throw researchError("fork policy requires an existing same-agent parent Session", 422, "ERR_RESEARCH_SESSION_POLICY");
      const parent = await provider().session({ root, id: parentSessionId });
      const parentTarget = await projectDirectory(root, parent.executionTarget);
      if (parent.workstreamId !== source.workstreamId || parentTarget !== target || valueString(parent.adapter) !== agent) {
        throw researchError("Fork parent does not match this workstream and execution target", 422, "ERR_RESEARCH_SESSION");
      }
      if (object(parent.capabilities).sessionFork === true && valueString(parent.nativeSessionId)) {
        return { agent, policy, sessionId: "", mode: "fork", parentSessionId, parent };
      }
      // Do not claim a hidden native conversation was forked.  The worker
      // creates a new session and the frozen spec records reconstruction.
      return { agent, policy, sessionId: "", mode: "fork-reconstructed", parentSessionId, parent,
        reason: "parent adapter lacks native ACP fork or native session identity" };
    }
    const sessions = await provider().sessions({ root, workstreamId: source.workstreamId, adapter: agent, limit: 200 });
    const eligible = source.workNodeId
      ? (await runsForSource()).map((run) => sessions.find((candidate) => (
        valueString(candidate.id) === valueString(run.sessionId || run.session_id)
      ))).filter(Boolean)
      : sessions;
    let session = null;
    for (const candidate of eligible) {
      if (!["active", "warm"].includes(candidate.state)) continue;
      try {
        if ((await projectDirectory(root, candidate.executionTarget)) === target) {
          session = candidate;
          break;
        }
      } catch {
        // A historical session outside this project is never eligible to resume.
      }
    }
    if (session) return { agent, policy, sessionId: session.id, mode: "continued", session };
    return { agent, policy: "fresh", sessionId: "", mode: "fresh", reason: "no resumable same-agent session" };
  }

	async function localExecutorDescriptor(source, body) {
	  if (source.projectType === "jupyter") {
		return { kind: "jupyter", kernel: valueString(body.kernel) || "python3" };
	  }
	  const command = valueString(body.interpreter) || "python3";
	  if (!/^(?:\/[^\0\n]+|[A-Za-z0-9][A-Za-z0-9._+-]*)$/.test(command)) {
		throw researchError("Python interpreter must be an absolute path or executable name", 422, "ERR_RESEARCH_PROJECT_FILE");
	  }
	  let path = command;
	  if (!isAbsolute(command)) {
		try {
		  path = valueString((await execFileAsync("/usr/bin/which", [command], { timeout: 5000 })).stdout);
		} catch {
		  throw researchError(`Python interpreter is not installed: ${command}`, 422, "ERR_RESEARCH_PROJECT_FILE");
		}
	  }
	  let version = "unknown";
	  try {
		const checked = await execFileAsync(path, ["--version"], { timeout: 5000 });
		version = valueString(checked.stdout) || valueString(checked.stderr) || version;
	  } catch (error) {
		throw researchError(`Python interpreter is not executable: ${error?.message || path}`, 422, "ERR_RESEARCH_PROJECT_FILE");
	  }
	  return { kind: "python", command, path, version };
	}

	async function prepareProjectFileRun(root, source, body) {
	  const target = await projectDirectory(root, body.executionTarget || body.cwd || root);
	  const capabilities = normalizeCapabilities(source.executor.capabilities, body.capabilities);
	  if (valueString(capabilities.execute) === "deny") {
		throw researchError("Project-file execution is denied by the capability policy", 403, "ERR_RESEARCH_CAPABILITY");
	  }
	  const pending = Object.entries(capabilities).filter(([, decision]) => valueString(decision) === "ask").map(([name]) => name);
	  if (pending.length && body.confirmed !== true) {
		throw researchError(`Project-file execution requires confirmation for: ${pending.join(", ")}`, 409, "ERR_RESEARCH_CONFIRMATION");
	  }
	  const executor = await localExecutorDescriptor(source, body);
	  const args = values(body.args).map((value) => String(value));
	  const spec = {
		schema: "noema.run-spec/1", project_id: await projectIdentity(root), workstream_id: source.workstreamId,
		source: {
		  kind: source.kind, uri: source.sourceRef, file: source.projectFile,
		  notebook_file: source.file, notebook_id: source.notebookId, cell_id: source.cellId,
		  work_node_id: source.workNodeId, notebook_revision: source.notebookRevision,
		  cell_source_sha256: source.cellSourceSHA256, content_sha256: source.projectSHA256,
		},
		executor, args, execution_target: target, cwd: target, capabilities,
		outputs: { stream: "run.content.segment", rich: "run.jupyter.outputs", artifacts: "run-file" },
		created_at: new Date().toISOString(),
	  };
	  const prepared = await provider().prepareRun({ root, run: {
		workstreamId: source.workstreamId, sessionId: "", notebookId: source.notebookId,
		cellId: source.cellId, workNodeId: source.workNodeId, sourceKind: source.kind,
		executionTarget: target, spec,
		contextManifest: { schema: "noema.context-manifest/1", items: [] }, contextItems: [],
	  }});
	  const run = object(prepared.run).id ? prepared.run : prepared;
	  const frozenSpec = object(prepared.spec).run_id ? prepared.spec : { ...spec, run_id: run.id };
	  if (valueString(run.id)) {
		runFileBaselines.set(valueString(run.id), { root, run, agent: "local", files: await snapshotProjectFiles(root) });
	  }
	  return { root, run, spec: frozenSpec, contextItems: [], routing: { mode: "local", executor } };
	}

	function reportLocalEvents(root, runId, events) {
	  const previous = localEventQueues.get(runId) || Promise.resolve();
	  const next = previous.catch(() => {}).then(() => provider().reportLocalRunEvents({
		root, events: { runId, events },
	  }));
	  localEventQueues.set(runId, next);
	  void next.finally(() => {
		if (localEventQueues.get(runId) === next) localEventQueues.delete(runId);
	  }).catch(() => {});
	  return next;
	}

	async function finishLocalRun(root, run, status, { transcript = "", failureReason = "" } = {}) {
	  const runId = valueString(run.id);
	  const baseline = runFileBaselines.get(runId);
	  let detected = { drafts: [], errors: [] };
	  if (baseline) detected = await detectRunFileArtifacts({ root, run, before: baseline.files, provider: provider() });
	  const errorText = detected.errors.length
		? `\nArtifact capture warnings:\n${detected.errors.map((item) => `${item.path}: ${item.message}`).join("\n")}\n`
		: "";
	  const events = [...detected.drafts];
	  if (errorText) events.push({ type: "run.content.segment", payload: { stream: "stderr", text: errorText } });
	  events.push({ type: "run.status.changed", payload: {
		status, ...(failureReason ? { failure_reason: failureReason } : {}),
		...(transcript ? { transcript_text: transcript } : {}),
	  }});
	  try {
		await reportLocalEvents(root, runId, events);
	  } finally {
		runFileBaselines.delete(runId);
		localRunProcesses.delete(runId);
	  }
	}

	async function executeProjectFile(root, run, spec) {
	  const runId = valueString(run.id);
	  const source = object(spec.source);
	  const projectPath = join(root, ...valueString(source.file).split("/"));
	  let transcript = "";
	  const appendTranscript = (text) => {
		if (transcript.length < RUN_ARTIFACT_MAX_BYTES) transcript += text.slice(0, RUN_ARTIFACT_MAX_BYTES - transcript.length);
	  };
	  try {
		if (valueString(object(spec.executor).kind) === "jupyter") {
		  const jupyter = getJupyterService();
		  if (typeof jupyter?.documentExecute !== "function") throw new Error("Noema Jupyter service is unavailable");
		  const execution = await jupyter.documentExecute({
			file: projectPath, sourceFile: projectPath, scriptFile: projectPath, projectRoot: root,
			kernel: valueString(object(spec.executor).kernel) || "python3", mode: "all",
		  });
		  const outputs = values(execution?.results).flatMap((result) => values(result?.outputs));
		  if (outputs.length) await reportLocalEvents(root, runId, [{ type: "run.jupyter.outputs", payload: { outputs } }]);
		  const ok = execution?.ok !== false;
		  await finishLocalRun(root, run, ok ? "completed" : "failed", {
			failureReason: ok ? "" : "Jupyter execution returned an error",
		  });
		  return;
		}
		await new Promise((resolveExecution) => {
		  const child = spawnProjectProcess(valueString(object(spec.executor).path), [projectPath, ...values(spec.args).map(String)], {
			cwd: valueString(spec.cwd), env: process.env, stdio: ["ignore", "pipe", "pipe"],
		  });
		  const state = { process: child, cancelled: false };
		  localRunProcesses.set(runId, state);
		  const stream = (name, chunk) => {
			const text = Buffer.from(chunk).toString("utf8");
			appendTranscript(text);
			void reportLocalEvents(root, runId, [{ type: "run.content.segment", payload: { stream: name, text } }]).catch(() => {});
		  };
		  child.stdout?.on("data", (chunk) => stream("stdout", chunk));
		  child.stderr?.on("data", (chunk) => stream("stderr", chunk));
		  child.once("error", async (error) => {
			await finishLocalRun(root, run, "failed", { transcript, failureReason: String(error?.message || error) }).catch(() => {});
			resolveExecution();
		  });
		  child.once("close", async (code, signal) => {
			if (!localRunProcesses.has(runId)) return resolveExecution();
			const status = state.cancelled ? "cancelled" : code === 0 ? "completed" : "failed";
			const failureReason = status === "failed" ? `Project process exited with ${signal ? `signal ${signal}` : `code ${code}`}` : "";
			await finishLocalRun(root, run, status, { transcript, failureReason }).catch(() => {});
			resolveExecution();
		  });
		});
	  } catch (error) {
		await finishLocalRun(root, run, "failed", { transcript, failureReason: String(error?.message || error) }).catch(() => {});
	  }
	}

	function schedulerLease(body = {}) {
	  const nested = Object.keys(object(body.lease)).length ? object(body.lease) : body;
	  return {
		jobId: valueString(nested.jobId || nested.job_id),
		invocationId: valueString(nested.invocationId || nested.invocation_id),
		workerId: valueString(nested.workerId || nested.worker_id), token: valueString(nested.token),
		epoch: Number(nested.epoch) || 0,
	  };
	}

	async function finishScheduledJob(body = {}, operation) {
	  const root = await rootFor(body);
	  const nested = Object.keys(object(body.completion)).length ? object(body.completion) : body;
	  const completion = {
		...schedulerLease(nested), result: structuredClone(object(nested.result)),
		artifactIds: values(nested.artifactIds || nested.artifact_ids).map(valueString).filter(Boolean),
		usage: structuredClone(object(nested.usage)), reason: valueString(nested.reason),
	  };
	  const method = operation === "complete" ? "completeJob" : operation === "fail" ? "failJob" : "reportJobUnresolved";
	  return { root, ...(await provider()[method]({ root, completion })) };
	}

  return {
	async cacheStatus(body = {}) {
	  const root = await rootFor(body);
	  return { root, cache: await provider().cacheStatus({ root }) };
	},

	async maintainCache(body = {}) {
	  const root = await rootFor(body);
	  return { root, cache: await maybeMaintainCache(root, true) };
	},

	async resolveCell(body = {}) {
	  const root = await rootFor(body);
	  const notebookId = valueString(body.notebookId || body.notebook_id);
	  const cellId = valueString(body.cellId || body.cell_id);
	  if (!notebookId.startsWith("nb_") || !cellId) {
		throw researchError("Valid notebook and cell ids are required", 400, "ERR_RESEARCH_CELL");
	  }
	  const location = await provider().resolveCell({ root, notebookId, cellId });
	  const resolved = await projectFile(root, valueString(location.path));
	  if (!isResearchDocumentPath(resolved.path)) {
		throw researchError("Indexed research cell does not belong to a .noema work document", 422, "ERR_RESEARCH_CELL");
	  }
	  const loaded = await readResearchNotebookFile(resolved.path);
	  const currentNotebookId = valueString(researchMeta({ metadata: loaded.notebook.metadata }).notebook_id);
	  if (currentNotebookId !== notebookId || !cellById(loaded.notebook, cellId)) {
		throw researchError("The indexed research cell is no longer present in the authoritative notebook", 409, "ERR_RESEARCH_CELL_STALE");
	  }
	  return {
		root, notebookId, cellId, file: resolved.path, path: resolved.relative,
		revision: loaded.revision, indexedRevision: valueString(location.revision),
	  };
	},

	async capabilities(body = {}) {
	  const scope = capabilityScope(body);
	  const root = scope === "global" ? null : await rootFor(body);
	  return {
		root,
		capabilities: await resolveProjectCapabilities({
		  root, scope,
		  requestedSkills: values(body.requestedSkills || body.requested_skills),
		  runtimeDescriptor: object(getRuntimeDescriptor()),
		}),
	  };
	},

	async capabilityConfig(body = {}) {
	  const scope = capabilityScope(body);
	  const root = scope === "global" ? null : await rootFor(body);
	  return { root, capabilityConfig: await projectCapabilityConfig(root, { scope }) };
	},

    async installSkill(body = {}) {
      const scope = capabilityScope(body);
      const root = scope === "global" ? null : await rootFor(body);
      const skill = await installProjectSkill({ root, scope,
        id: valueString(body.id), description: valueString(body.description),
        sourceDirectory: valueString(body.sourceDirectory) });
      return { root, skill, capabilities: await resolveProjectCapabilities({ root, scope,
        runtimeDescriptor: object(getRuntimeDescriptor()) }) };
    },

    async prepareSkill(body = {}) {
      const root = await rootFor(body);
      const skill = await prepareProjectSkill({ root, id: valueString(body.id), operation: valueString(body.operation) });
      return { root, skill, capabilities: await resolveProjectCapabilities({ root,
        runtimeDescriptor: object(getRuntimeDescriptor()) }) };
    },

    async capabilityFiles(body = {}) {
      const root = await rootFor(body);
      const directory = await projectDirectory(root, valueString(body.directory) || ".");
      const entries = await readdir(directory, { withFileTypes: true });
      const files = entries.filter((entry) => ![".git", ".agent", "node_modules"].includes(entry.name))
        .map((entry) => entry.name + (entry.isDirectory() ? "/" : "")).sort();
      return { root, files: files.slice(0, 2000), truncated: files.length > 2000 };
    },

    async probeMCP(body = {}) {
      const scope = capabilityScope(body);
      const root = scope === "global" ? null : await rootFor(body);
      const environment = await resolveProjectCapabilities({ root, scope, runtimeDescriptor: object(getRuntimeDescriptor()) });
      const record = environment.mcps.find((item) => item.id === valueString(body.id));
      if (!record || !record.validation.valid) {
        throw researchError(record?.validation.errors.join("; ") || "Unknown MCP", 422, "ERR_NOEMA_MCP");
      }
      const [config] = resolvedMCPServersForRun({ ...environment, mcps: [{ ...record, enabled: true }] });
      return { root, id: record.id, probe: await provider().probeMCP({
        root: root || dirname(environment.configFile), config,
        ...(scope === "global" ? { scope } : {}),
      }) };
    },

	async mutateCapability(body = {}) {
	  const scope = capabilityScope(body);
	  const root = scope === "global" ? null : await rootFor(body);
	  const mutation = await mutateProjectCapability({
		root, scope,
		type: valueString(body.type),
		id: valueString(body.id),
		enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
		patch: Object.hasOwn(body, "patch") ? body.patch : undefined,
		definition: Object.hasOwn(body, "definition") ? body.definition : undefined,
	  });
	  return {
		root,
		mutation,
		capabilities: await resolveProjectCapabilities({
		  root, scope, runtimeDescriptor: object(getRuntimeDescriptor()),
		}),
	  };
	},

    async prepareRun(body = {}, { dryRun = false } = {}) {
      const root = await rootFor(body);
      let preview = null;
      if (dryRun && body.notebook && valueString(body.file)) {
        // Preview what the unsaved document would run with.
        preview = await readResearchNotebookFile(valueString(body.file));
        if (!validateResearchNotebook(body.notebook).ok) {
          throw researchError("Invalid context preview document", 422, "ERR_RESEARCH_FORMAT");
        }
        preview.notebook = body.notebook;
      }
      const source = await sourceForRun(root, body, preview);
      const runtimeProvider = provider();
      if (dryRun && source.kind !== "work-cell") {
        throw researchError("Context preview needs a work cell", 422, "ERR_RESEARCH_RUN");
      }
	  if (!dryRun && (source.kind === "work-cell" || source.kind === "project-file") && typeof runtimeProvider.index === "function") {
        // A canonical document can be opened before this host's rebuildable
        // Go index has ever seen it.  Synchronize the file before any
        // Workstream/Run lookup so first execution works without a dummy save.
        await runtimeProvider.index({
          root,
          path: source.file,
          actor: "node",
          reason: "run.prepare",
        });
      }
	  if (source.kind === "project-file") return prepareProjectFileRun(root, source, body);
      const target = await projectDirectory(root, body.executionTarget || body.cwd || root);
      if (!dryRun && typeof runtimeProvider.expireLeases === "function") {
        // D-035: a worker that vanished (Emacs crashed or was killed) leaves an
        // expired lease.  Recover it before routing so its session is neither
        // reported busy nor resumed as if it were still held.  Leases released
        // by finished Runs are skipped by the kernel without any event.
        try {
          await runtimeProvider.expireLeases({ root });
        } catch {
          // Recovery is best effort; routing still reports a truly busy session.
        }
      }
	  if (!dryRun) forgetPreviewSnapshot(root);
	  let route = await routeRun(root, source, target, body, { dryRun });
	  route = await compactRouteIfNeeded(root, route, body, { dryRun });
      const requestedContext = [...values(source.context), ...values(body.context)];
      // `@@ctx(none)` keeps only what the block declares: no derived lineage and
      // no upstream outputs are attached automatically (D-036).
      const automaticContext = !requestedContext.some((entry) => contextRef(entry).ref === "none");
      const declaredContext = requestedContext.filter((entry) => contextRef(entry).ref !== "none");
      // A derived branch carries its lineage as explicit context, never as a
      // hidden conversation (D-031).  The direct parents' latest outputs come
      // first: a new conversation needs what upstream concluded, not only what
      // upstream was asked (D-036).  Everything here is automatic context and
      // yields to the declared context budget.
      const automaticRefs = [];
      if (automaticContext && values(route.autoContext).length && source.notebook && source.workNodeId) {
        for (const parentId of researchWorkNodeSummary(source.notebook, source.workNodeId).lineage) {
          if (latestOutputForWork(source.notebook, parentId)) automaticRefs.push({ ref: `result:${parentId}`, auto: true });
        }
        for (const ref of values(route.autoContext)) automaticRefs.push({ ref, auto: true });
      }
      let reconstruction = null;
      if (route.mode === "fork-reconstructed") {
        reconstruction = await latestParentHandoff(provider(), root, route.parentSessionId,
          valueString(route.reconstructFromWorkNode));
      }
      const parentOutput = reconstruction?.run && source.notebook
        && valueString(reconstruction.run.notebookId) === source.notebookId
        && latestOutputForWork(source.notebook, valueString(reconstruction.run.workNodeId || reconstruction.run.cellId));
      // The reconstructed parent's output substitutes for the conversation a
      // fork does not inherit, so `@@ctx(none)` keeps it; it still yields to
      // declared context when the budget is short.
      const reconstructedForkContext = parentOutput && !valueString(route.compaction?.id)
        ? [{ ref: `result:${valueString(reconstruction.run.workNodeId || reconstruction.run.cellId)}`, auto: true }]
        : [];
      const candidateContext = await resolveContextItems({ root, notebook: source.notebook, sourceCell: source.cell,
        declared: [...declaredContext, ...reconstructedForkContext, ...automaticRefs], provider: provider(),
        sessionId: route.sessionId, resolveKnowledgeNote });
      if (route.mode !== "continued" && source.kind === "work-cell") {
        // A new conversation knows nothing yet: say where it runs.
        candidateContext.unshift(projectContextItem({ root, source }));
      }
      if (reconstruction?.item) {
        candidateContext.push(valueString(route.compaction?.id)
          ? boundedContextItem(reconstruction.item, COMPACTION_CHECKPOINT_MAX_BYTES)
          : reconstruction.item);
      }
      const skillIds = [...values(source.executor.skills), ...values(body.skills)].map(valueString).filter(Boolean);
      const capabilityEnvironment = assertRunnableCapabilities(await resolveProjectCapabilities({
        root,
        requestedSkills: skillIds,
        runtimeDescriptor: object(getRuntimeDescriptor()),
        includeContent: true,
      }));
      const resolvedSkills = resolvedSkillsForRun(capabilityEnvironment);
      candidateContext.push(...resolvedSkills.items);
      const automaticContextRefs = new Set(candidateContext.filter((item) => item.auto).map((item) => item.ref));
      const { items: contextItems, omitted: omittedContext } = fitAutomaticContext(candidateContext);
      const capabilities = normalizeCapabilities(source.executor.capabilities, body.capabilities);
      assertCapabilityEnvelope(route.agent, capabilities, body, source.executor);
      const externalSandbox = Boolean(body.externalSandbox ?? body.external_sandbox ?? source.executor.external_sandbox);
      const mcpServers = resolvedMCPServersForRun(capabilityEnvironment);
      const capabilitySnapshot = structuredClone(capabilityEnvironment);
      capabilitySnapshot.skills = values(capabilitySnapshot.skills).filter((item) => item.enabled);
      capabilitySnapshot.mcps = values(capabilitySnapshot.mcps).filter((item) => item.enabled);
      const activeKeys = new Set([
        ...capabilitySnapshot.skills.map((item) => `skill:${item.id}`),
        ...capabilitySnapshot.mcps.map((item) => `mcp:${item.id}`),
      ]);
      capabilitySnapshot.diagnostics = values(capabilitySnapshot.diagnostics)
        .filter((item) => activeKeys.has(`${item.type}:${item.id}`));
      for (const skill of capabilitySnapshot.skills) delete object(skill.effective).content;
      const spec = {
        schema: "noema.run-spec/1",
        project_id: await projectIdentity(root),
        workstream_id: source.workstreamId,
        source: {
          kind: source.kind,
          uri: source.sourceRef,
          file: source.file,
          notebook_id: source.notebookId || undefined,
          cell_id: source.cellId || undefined,
          work_node_id: source.workNodeId || undefined,
          notebook_revision: source.notebookRevision || undefined,
          cell_source_sha256: source.cellSourceSHA256,
        },
        prompt: source.prompt,
        prompt_sha256: `sha256:${sha256(source.prompt)}`,
        agent: agentDescriptor(route.agent, body),
        session: {
          policy: route.policy,
          session_id: route.sessionId || "",
          native_session_id: valueString(route.session?.nativeSessionId),
          ...(route.sessionName ? { name: route.sessionName.name, parent_name: route.sessionName.parentName || undefined } : {}),
          ...(route.derivation ? { derivation: route.derivation } : {}),
		  ...(valueString(route.compaction?.id) ? { compaction_id: valueString(route.compaction.id) } : {}),
        },
        session_policy: route.policy,
        execution_target: target,
        cwd: target,
        skills: resolvedSkills.skills,
        capabilities,
        external_sandbox: externalSandbox,
        context: contextItems.map(publicContextItem),
        ...(omittedContext.length ? { context_omitted: omittedContext } : {}),
        mcp_servers: mcpServers,
        capability_environment: capabilitySnapshot,
        created_at: new Date().toISOString(),
      };
      if (route.parentSessionId) spec.parent_session_id = route.parentSessionId;
	  if (valueString(route.compaction?.id)) spec.compaction = structuredClone(route.compaction);
      if (route.mode === "fork") spec.fork_mode = "native";
      if (route.mode === "fork-reconstructed") {
        spec.fork_mode = "reconstructed";
        spec.fork_notice = "No hidden parent conversation was inherited; only frozen source, declared context, an available parent work output, and Handoff were provided.";
      }
      if (dryRun) {
        const size = (item) => Buffer.from(item.contentBase64, "base64").byteLength;
        return {
          root,
          routing: {
            agent: route.agent, mode: route.mode, policy: route.policy,
            name: valueString(route.sessionName?.name), parentName: valueString(route.sessionName?.parentName),
            rule: valueString(route.derivation?.rule), reason: valueString(route.derivation?.reason || route.reason),
            busy: Boolean(route.busy), rollover: valueString(route.compaction?.id) !== "",
          },
          context: contextItems.map((item) => ({
            ref: item.ref, resolvedUri: item.resolvedUri, mediaType: item.mediaType,
            bytes: size(item), truncated: Boolean(item.truncated), automatic: automaticContextRefs.has(item.ref),
          })),
          omitted: omittedContext,
          totalBytes: contextItems.reduce((sum, item) => sum + size(item), 0),
          limitBytes: CONTEXT_LIMIT_BYTES,
          promptBytes: Buffer.byteLength(source.prompt),
        };
      }
      const prepared = await provider().prepareRun({
        root,
        run: {
          workstreamId: source.workstreamId,
          sessionId: route.sessionId,
          ...(route.sessionName ? { sessionName: route.sessionName } : {}),
          notebookId: source.notebookId,
          cellId: source.cellId,
          workNodeId: source.workNodeId,
          sourceKind: source.kind,
          executionTarget: target,
          spec,
          contextManifest: { schema: "noema.context-manifest/1", items: spec.context },
          contextItems,
        },
      });
      const run = object(prepared.run).id ? prepared.run : prepared;
      const frozenSpec = object(prepared.spec).run_id ? prepared.spec : { ...spec, run_id: run.id };
      if (valueString(run.id)) {
        sweepRunFileBaselines();
        runFileBaselines.set(valueString(run.id), {
          root, run, agent: route.agent, files: await snapshotProjectFiles(root), createdAt: Date.now(),
        });
      }
      return { root, run, spec: frozenSpec, contextItems, routing: route };
    },

    // Resolve the route and context a work block would run with, without
    // freezing a RunSpec, requesting compaction or dispatching (D-036).
    async previewRunContext(body = {}) {
      return this.prepareRun(body, { dryRun: true });
    },

	async runProjectFile(body = {}) {
	  const prepared = await this.prepareRun(body);
	  const run = await provider().startLocalRun({
		root: prepared.root, start: { runId: valueString(prepared.run?.id) },
	  });
	  void executeProjectFile(prepared.root, run, prepared.spec);
	  return { ...prepared, run };
	},

    async sessionNames(body = {}) {
      const root = await rootFor(body);
      return { root, names: await provider().sessionNames({ root, includeArchived: Boolean(body.includeArchived) }) };
    },

    async sessionName(body = {}) {
      const root = await rootFor(body);
      return { root, name: await provider().sessionName({ root, name: valueString(body.name) }) };
    },

	async sessionContext(body = {}) {
	  const root = await rootFor(body);
	  return { root, context: await provider().sessionContext({
		root, sessionId: valueString(body.sessionId || body.session_id),
	  }) };
	},

	async compactSession(body = {}) {
	  const root = await rootFor(body);
	  return { root, compaction: await provider().requestSessionCompaction({
		root, sessionId: valueString(body.sessionId || body.session_id),
	  }) };
	},

    async declareSessionName(body = {}) {
      const root = await rootFor(body);
      forgetPreviewSnapshot(root);
      const origin = valueString(body.origin) === "pi" ? "pi" : "user";
      const intent = {
        name: validateSessionName(body.name), agent: valueString(body.agent).toLowerCase(),
        parentName: valueString(body.parentName || body.parent_name), forkMode: "reconstructed", origin,
      };
      return { root, name: await provider().declareSessionName({ root, intent }) };
    },

    // Bind a name to an already-promoted Session: the per-project Pi
    // coordinator (origin system) or a human naming a live agent buffer.
    async bindSessionName(body = {}) {
      const root = await rootFor(body);
      forgetPreviewSnapshot(root);
      const name = validateSessionName(body.name, { allowPi: true });
      const sessionId = valueString(body.sessionId || body.session_id);
      if (!sessionId.startsWith("ses_")) throw researchError("Binding a session name needs a promoted Session", 422, "ERR_RESEARCH_SESSION_NAME");
      const intent = { name, agent: valueString(body.agent).toLowerCase(), origin: name === PI_SESSION_NAME ? "system" : "user" };
      return { root, name: await provider().bindSessionName({ root, intent, sessionId }) };
    },

    async renameSessionName(body = {}) {
      const root = await rootFor(body);
      forgetPreviewSnapshot(root);
      return { root, name: await provider().renameSessionName({ root, rename: {
        name: valueString(body.name), newName: validateSessionName(body.newName || body.new_name),
        actor: valueString(body.actor) || "emacs",
      } }) };
    },

    async archiveSessionName(body = {}) {
      const root = await rootFor(body);
      forgetPreviewSnapshot(root);
      return { root, name: await provider().archiveSessionName({ root, archive: {
        name: valueString(body.name), archived: body.archived !== false, actor: valueString(body.actor) || "emacs",
      } }) };
    },

    // Dry-run the D-031 route for visible work blocks so JuText can show which
    // conversation each block will use before anything runs.
    async resolveSessions(body = {}) {
      const root = await rootFor(body);
      const file = valueString(body.file);
      const target = await projectDirectory(root, body.executionTarget || body.cwd || root);
      const loaded = await readResearchNotebookFile(file);
      if (body.notebook) {
        const validation = validateResearchNotebook(body.notebook);
        if (!validation.ok) throw researchError("Invalid route preview document", 422, "ERR_RESEARCH_FORMAT");
        loaded.notebook = body.notebook;
      }
      await refreshExpiredLeases(root);
      const snapshot = await previewRoutingSnapshot(root);
      const sessions = [];
      for (const cellId of values(body.cellIds).map(valueString).filter(Boolean)) {
        try {
          const source = await sourceForRun(root, { file, cellId }, loaded);
          const route = await routeRun(root, source, target, {}, { dryRun: true, snapshot });
          const latestRun = values(snapshot[1]).find((run) => run.notebookId === source.notebookId && run.cellId === cellId);
          sessions.push({
            cellId, agent: route.agent, mode: route.mode, name: valueString(route.sessionName?.name),
            parentName: valueString(route.sessionName?.parentName), rule: valueString(route.derivation?.rule),
            reason: valueString(route.derivation?.reason || route.reason), busy: Boolean(route.busy),
            latestRun: latestRun ? { id: latestRun.id, status: latestRun.status } : null,
          });
        } catch (error) {
          sessions.push({ cellId, error: String(error?.message || error) });
        }
      }
      return { root, sessions };
    },

    // Where Pi reaches Noema: the shared MCP endpoint plus the D-032
    // coordinator endpoint served by the same kernel.
    async coordinatorEndpoint() {
      const mcpUrl = valueString(object(getRuntimeDescriptor()).mcpUrl);
      return { mcpUrl, coordinatorUrl: mcpUrl ? `${mcpUrl}/coordinator` : "" };
    },

    async claimCoordinatorRequests(body = {}) {
      const root = await rootFor(body);
      return { root, requests: await provider().claimCoordinatorRequests({ root, owner: valueString(body.owner) || "emacs" }) };
    },

    async completeCoordinatorRequest(body = {}) {
      const root = await rootFor(body);
      return {
        root,
        request: await provider().completeCoordinatorRequest({
          root,
          id: valueString(body.id || body.requestId || body.request_id),
          owner: valueString(body.owner) || "emacs",
          state: valueString(body.state),
          reason: valueString(body.reason),
        }),
      };
    },

    async runs(body = {}) {
      const root = await rootFor(body);
      await refreshExpiredLeases(root);
      const runs = await provider().runs({
        root,
        workstreamId: valueString(body.workstreamId || body.workstream_id),
        sessionId: valueString(body.sessionId || body.session_id),
        limit: Math.min(1000, Math.max(1, Number(body.limit) || 200)),
      });
      return { root, runs };
    },

    async run(body = {}) {
      const root = await rootFor(body);
      await refreshExpiredLeases(root);
      return { root, run: await provider().run({ root, id: valueString(body.id || body.runId || body.run_id) }) };
    },

    async liveRun(body = {}) {
      const root = await rootFor(body);
      await refreshExpiredLeases(root);
      return {
        root,
        ...(await provider().liveRun({
          root,
          id: valueString(body.id || body.runId || body.run_id),
          after: Math.max(0, Number(body.after) || 0),
          limit: Math.min(1000, Math.max(1, Number(body.limit) || 200)),
        })),
      };
    },

    async checkRunCompletion(body = {}) {
      const root = await rootFor(body);
      let runId = valueString(body.runId || body.id);
      let source;
      if (body.file && body.cellId) {
        source = await sourceForRun(root, { file: body.file, cellId: body.cellId });
        if (!runId) {
          const runs = await provider().runs({ root, workstreamId: source.workstreamId, limit: 1000 });
          runId = valueString(runs.find((run) => run.notebookId === source.notebookId && run.cellId === source.cellId)?.id);
        }
      }
      if (!runId) return { root, run: null, detection: "no-run", delivered: false };
      let run = await provider().run({ root, id: runId });
      if (source && (run.cellId !== source.cellId || run.notebookId !== source.notebookId)) {
        throw researchError("Run does not belong to this output cell", 409, "ERR_RESEARCH_RUN");
      }
      await refreshExpiredLeases(root, true);
      run = await provider().run({ root, id: runId });
      const terminal = ["completed", "cancelled", "failed", "interrupted"].includes(run.status);
      if (terminal) return { root, run, detection: "terminal", delivered: false, result: await repairRunOutput(root, run) };
      const delivered = Boolean(deliverWorkerCommand({ type: "run-check-completion", root, runId, sessionId: run.sessionId }));
      return { root, run, detection: delivered ? "requested" : "worker-unavailable", delivered };
    },

    async cancelRun(body = {}) {
      const root = await rootFor(body);
      await refreshExpiredLeases(root, true);
      const requestedBy = valueString(body.requestedBy || body.requested_by) || "node";
      const runId = valueString(body.id || body.runId || body.run_id);
      let run;
      try {
        run = await provider().requestRunCancellation({ root, cancellation: { runId, requestedBy } });
      } catch (error) {
        // Completion or lease expiry can win the cancellation race.
        if (!provider().run) throw error;
        run = await provider().run({ root, id: runId });
        if (!["completed", "cancelled", "failed", "interrupted"].includes(run.status)) throw error;
        return { root, run, delivered: false, result: await repairRunOutput(root, run) };
      }
	  const local = localRunProcesses.get(valueString(run.id));
	  if (local?.process) {
		local.cancelled = true;
		try { local.process.kill("SIGTERM"); } catch {}
	  }
	  const delivered = Boolean(local?.process) || Boolean(deliverWorkerCommand({
        type: "run-cancel", root, runId: run.id, sessionId: run.sessionId, requestedBy,
      }));
      if (["completed", "cancelled", "failed", "interrupted"].includes(valueString(run.status))) forgetRunFileBaseline(run.id);
      // A Run cancelled before dispatch ends in the kernel at once and no
      // worker will report it: persist that outcome as the cell output so
      // the document and OutputArea stop waiting for it.
      let result = null;
      let resultError = null;
      if (valueString(run.status) === "cancelled" && valueString(run.cellId) && valueString(run.notebookId)
          && typeof provider().resolveCell === "function") {
        try {
          const cell = await provider().resolveCell({ root, notebookId: run.notebookId, cellId: run.cellId });
          const file = await projectFile(root, valueString(cell?.path));
          await provider().queueNotebookWriteback({ root, writeback: {
            runId: run.id,
            notebookPath: file.relative,
            cellId: run.cellId,
            output: {
              notebookId: run.notebookId,
              workId: run.workNodeId || run.cellId,
              agent: "",
              status: "cancelled",
              content: `Run ${run.id} was cancelled before it started.`,
            },
          } });
          let completed = await drainNotebookWritebacks(root);
          if (!completed.has(run.id)) completed = await drainNotebookWritebacks(root);
          result = completed.get(run.id) || null;
          if (result?.error) resultError = result.error;
        } catch (error) {
          resultError = String(error?.message || error);
        }
      }
      return { root, run, delivered, result, resultError };
    },

    async failPreparingRun(body = {}) {
      const root = await rootFor(body);
      const runId = valueString(body.id || body.runId || body.run_id);
      const failureReason = valueString(body.failureReason || body.failure_reason) || "worker bootstrap failed";
      const run = await provider().failPreparedRun({ root, failure: { runId, failureReason } });
      forgetRunFileBaseline(runId);
      // A Run that failed before dispatch never emits a terminal worker event.
      // Persist its failure as the cell output like any other terminal Run, so
      // OutputArea does not wait forever for this Run's writeback.
      let result = null;
      let resultError = null;
      const notebookFile = valueString(body.notebookFile || body.notebook_file);
      if (notebookFile && valueString(run?.cellId)) {
        try {
          const file = await projectFile(root, notebookFile);
          await provider().queueNotebookWriteback({ root, writeback: {
            runId,
            notebookPath: file.relative,
            cellId: run.cellId,
            output: {
              notebookId: run.notebookId,
              workId: run.workNodeId || run.cellId,
              agent: valueString(body.agent),
              status: "failed",
              content: failureReason,
            },
          } });
          let completed = await drainNotebookWritebacks(root);
          if (!completed.has(runId)) completed = await drainNotebookWritebacks(root);
          result = completed.get(runId) || null;
          if (result?.error) resultError = result.error;
        } catch (error) {
          resultError = String(error?.message || error);
        }
      }
      return { root, run, result, resultError };
    },

    async readArtifact(body = {}) {
      const root = await rootFor(body);
      return {
        root,
        ...(await provider().readArtifact({ root, id: valueString(body.id || body.artifactId || body.artifact_id) })),
      };
    },

	async importArtifact(body = {}) {
	  const root = await rootFor(body);
	  const nested = Object.keys(object(body.artifact)).length ? object(body.artifact) : body;
	  const artifact = await provider().importArtifact({ root, artifact: {
		kind: valueString(nested.kind) || "worker-output",
		mediaType: valueString(nested.mediaType || nested.media_type) || "text/plain; charset=utf-8",
		contentBase64: valueString(nested.contentBase64 || nested.content_base64),
		workstreamId: valueString(nested.workstreamId || nested.workstream_id),
		runId: valueString(nested.runId || nested.run_id),
		sourceUri: valueString(nested.sourceUri || nested.source_uri) || "local-import",
		metadata: structuredClone(object(nested.metadata)),
	  }});
	  return { root, artifact };
	},

	async artifactLinks(body = {}) {
	  const root = await rootFor(body);
	  const links = await provider().artifactLinks({
		root,
		workstreamId: valueString(body.workstreamId || body.workstream_id),
		notebookId: valueString(body.notebookId || body.notebook_id),
		workNodeId: valueString(body.workNodeId || body.work_node_id),
		runId: valueString(body.runId || body.run_id),
		limit: Math.min(1000, Math.max(1, Number(body.limit) || 200)),
	  });
	  return { root, links };
	},

	async indexArtifactCorpus(body = {}) {
	  const root = await rootFor(body);
	  const nested = Object.keys(object(body.index)).length ? object(body.index) : body;
	  const index = await provider().indexArtifactCorpus({ root, index: {
		workstreamId: valueString(nested.workstreamId || nested.workstream_id),
		relativeRoot: valueString(nested.relativeRoot || nested.relative_root) || ".",
		actor: valueString(nested.actor) || "human:local-corpus",
	  }});
	  return { root, index };
	},

	async indexArtifactFiles(body = {}) {
	  const root = await rootFor(body);
	  const nested = Object.keys(object(body.index)).length ? object(body.index) : body;
	  const index = await provider().indexArtifactFiles({ root, index: {
		workstreamId: valueString(nested.workstreamId || nested.workstream_id),
		paths: values(nested.paths).map(valueString).filter(Boolean),
		actor: valueString(nested.actor) || "human:local-corpus",
	  }});
	  return { root, index };
	},

	async searchArtifactBlocks(body = {}) {
	  const root = await rootFor(body);
	  const nested = Object.keys(object(body.search)).length ? object(body.search) : body;
	  const hits = await provider().searchArtifactBlocks({ root, search: {
		workstreamId: valueString(nested.workstreamId || nested.workstream_id),
		query: valueString(nested.query), limit: Math.min(1000, Math.max(1, Number(nested.limit) || 20)),
	  }});
	  return { root, hits };
	},

	async readArtifactBlock(body = {}) {
	  const root = await rootFor(body);
	  const block = await provider().readArtifactBlock({ root, id: valueString(body.id || body.blockId || body.block_id) });
	  return { root, block };
	},

    async workerLease(body = {}) {
      const root = await rootFor(body);
      const lease = {
        sessionId: valueString(body.sessionId || body.session_id),
        owner: valueString(body.owner),
        epoch: Number(body.epoch) || 0,
        ttlMillis: Math.min(60_000, Math.max(5_000, Number(body.ttlMillis || body.ttl_millis) || 30_000)),
      };
      const acquired = lease.epoch > 0
        ? await provider().renewLease({ root, lease })
        : await provider().acquireLease({ root, lease });
      return { root, lease: acquired };
    },

    async workerAttach(body = {}) {
      const root = await rootFor(body);
      const run = await provider().attachRun({
        root,
        attachment: {
          sessionId: valueString(body.sessionId || body.session_id), owner: valueString(body.owner),
          epoch: Number(body.epoch) || 0, runId: valueString(body.runId || body.run_id),
		  compactionId: valueString(body.compactionId || body.compaction_id),
        },
      });
      return { root, run };
    },

    async workerStart(body = {}) {
      const root = await rootFor(body);
      const run = await provider().startRun({
        root,
        start: {
          sessionId: valueString(body.sessionId || body.session_id), owner: valueString(body.owner),
          epoch: Number(body.epoch) || 0, runId: valueString(body.runId || body.run_id),
        },
      });
      return { root, run };
    },

    async workerEvents(body = {}) {
      const root = await rootFor(body);
      const drafts = values(body.events);
      const runId = valueString(body.runId || body.run_id);
      const terminal = [...drafts].reverse().find((event) => {
        if (valueString(event?.type) !== "run.status.changed") return false;
        return ["completed", "cancelled", "failed", "interrupted"].includes(valueString(event?.payload?.status));
      });
      const baseline = terminal ? runFileBaselines.get(runId) : null;
      let artifactErrors = [];
      let durableRun = baseline?.run || null;
      let reportedDrafts = drafts;
      if (terminal && baseline) {
        try {
          const detected = await detectRunFileArtifacts({ root, run: durableRun, before: baseline.files, provider: provider() });
          reportedDrafts = [...detected.drafts, ...drafts];
          artifactErrors = detected.errors;
        } catch (error) {
          // Artifact discovery is auxiliary; it must never eat completion.
          artifactErrors = [String(error?.message || error)];
        }
      }
	  const sessionUsage = object(body.sessionUsage || body.session_usage);
      const events = await provider().reportWorkerEvents({
        root,
        events: {
          sessionId: valueString(body.sessionId || body.session_id), owner: valueString(body.owner),
          epoch: Number(body.epoch) || 0, runId,
		  events: reportedDrafts,
		  ...(Object.keys(sessionUsage).length ? { sessionUsage } : {}),
        },
      });
      if (terminal) {
        runFileBaselines.delete(runId);
        forgetPreviewSnapshot(root);
      }
      let result = null;
      let resultError = null;
      const notebookFile = valueString(body.notebookFile || body.notebook_file);
      if (terminal && notebookFile) {
        try {
          durableRun ||= await provider().run({ root, id: runId });
          const file = await projectFile(root, notebookFile);
		  await provider().queueNotebookWriteback({ root, writeback: {
			runId,
			notebookPath: file.relative,
			cellId: durableRun.cellId,
			output: {
			  notebookId: durableRun.notebookId,
			  workId: durableRun.workNodeId || durableRun.cellId,
			  agent: baseline?.agent || "",
			  status: valueString(terminal.payload?.status),
			  content: String(terminal.payload?.result_text || ""),
			},
		  } });
		  let completed = await drainNotebookWritebacks(root);
		  // A startup recovery drain may already have claimed its batch before
		  // this terminal Run queued.  One exact second pass closes that race.
		  if (!completed.has(runId)) completed = await drainNotebookWritebacks(root);
		  result = completed.get(runId) || null;
		  if (result?.error) resultError = result.error;
        } catch (error) {
          // The Run event is already authoritative and must not be rolled back
          // when the human-edited notebook has concurrently changed.
          resultError = String(error?.message || error);
        }
      }
	  if (terminal) void maybeMaintainCache(root).catch(() => {});
      return { root, events, result, resultError, artifactErrors };
    },

    async workerPermission(body = {}) {
      const root = await rootFor(body);
      const permission = await provider().requestWorkerPermission({
        root,
        permission: {
          sessionId: valueString(body.sessionId || body.session_id), owner: valueString(body.owner),
          epoch: Number(body.epoch) || 0, runId: valueString(body.runId || body.run_id),
          nativeRequestId: valueString(body.nativeRequestId || body.native_request_id),
          action: object(body.action || body.toolCall || body.tool_call), options: values(body.options),
        },
      });
      return { root, permission, autoDecision: permission.optionId || "" };
    },

    async workerInput(body = {}) {
      const root = await rootFor(body);
      const request = await provider().requestWorkerInput({
        root,
        input: {
          sessionId: valueString(body.sessionId || body.session_id), owner: valueString(body.owner),
          epoch: Number(body.epoch) || 0, runId: valueString(body.runId || body.run_id),
          nativeRequestId: valueString(body.nativeRequestId || body.native_request_id || body.requestId || body.request_id),
          prompt: valueString(body.prompt), inputKind: valueString(body.inputKind || body.input_kind) || "text",
          options: values(body.options),
        },
      });
      return { root, request };
    },

    async permission(body = {}) {
      const root = await rootFor(body);
      return { root, permission: await provider().permission({ root, id: valueString(body.id || body.permissionId || body.perm_id) }) };
    },

    async decidePermission(body = {}) {
      const root = await rootFor(body);
      const permission = await provider().decidePermission({
        root,
        decision: {
          permissionId: valueString(body.permissionId || body.permission_id || body.permId || body.perm_id),
          optionId: valueString(body.optionId || body.option_id),
          expectedVersion: Number(body.expectedVersion || body.expected_version) || 0,
          decidedBy: valueString(body.decidedBy || body.decided_by || "node"),
        },
      });
      const delivered = Boolean(deliverWorkerCommand({
        type: "permission-decision", root, permissionId: permission.id, optionId: permission.optionId,
        sessionId: permission.sessionId, runId: permission.runId, epoch: permission.epoch,
      }));
      return { root, permission, delivered };
    },

    async inputRequest(body = {}) {
      const root = await rootFor(body);
      return { root, request: await provider().inputRequest({ root, id: valueString(body.id || body.requestId || body.request_id) }) };
    },

    async respondInput(body = {}) {
      const root = await rootFor(body);
      const request = await provider().respondInput({
        root,
        response: {
          runId: valueString(body.runId || body.run_id),
          requestId: valueString(body.requestId || body.request_id),
          answer: body.answer,
          answeredBy: valueString(body.answeredBy || body.answered_by) || "node",
        },
      });
      const delivered = Boolean(deliverWorkerCommand({
        type: "input-response", root, runId: request.runId, sessionId: request.sessionId,
        requestId: request.id, nativeRequestId: request.nativeRequestId, answer: request.answer, epoch: request.epoch,
      }));
      return { root, request, delivered };
    },

    async attention(body = {}) {
      const root = await rootFor(body);
      const attention = await provider().attention({ root });
      if (valueString(body.disclosureView || body.disclosure_view) === "remote") {
        attention.proposals = values(attention.proposals).filter((proposal) =>
          !containsLocalDisclosure(proposal.payload) && !containsLocalDisclosure(proposal.reviewedPayload));
      }
      return { root, ...attention };
    },

    async createProposal(body = {}) {
      const root = await rootFor(body);
      const clientRequestId = valueString(body.clientRequestId || body.client_request_id);
      const kind = valueString(body.kind);
      let payload = structuredClone(object(body.payload));
      if (kind === "cell.create") {
        const nested = Object.keys(object(payload.cell)).length ? structuredClone(object(payload.cell)) : payload;
        const cellId = valueString(nested.cellId || nested.cell_id) || proposedCellId(clientRequestId);
        nested.cellId = cellId;
        delete nested.cell_id;
        payload = Object.keys(object(payload.cell)).length ? { ...payload, cell: nested } : nested;
      }
      const proposal = await provider().createProposal({
        root,
        proposal: {
          clientRequestId,
          workstreamId: valueString(body.workstreamId || body.workstream_id),
          kind,
          payload,
          proposedBy: valueString(body.proposedBy || body.proposed_by) || "agent:unknown",
          sourceAdapter: valueString(body.sourceAdapter || body.source_adapter) || "unknown",
        },
      });
      return { root, proposal };
    },

    async supervisorProposal(body = {}) {
      const root = await rootFor(body);
      const nested = object(body.proposal);
      const candidate = Object.keys(nested).length ? nested : body;
      for (const key of ["decision", "acceptedRef", "accepted_ref", "reviewedBy", "reviewed_by", "status", "version"]) {
        if (Object.hasOwn(candidate, key)) {
          throw researchError(`Pi supervisor hook cannot submit authority field ${key}`, 422, "ERR_RESEARCH_PROPOSAL");
        }
      }
      const clientRequestId = valueString(candidate.clientRequestId || candidate.client_request_id);
      const kind = valueString(candidate.kind);
      let payload = structuredClone(object(candidate.payload));
      if (kind === "cell.create") {
        const cell = Object.keys(object(payload.cell)).length ? structuredClone(object(payload.cell)) : payload;
        cell.cellId = valueString(cell.cellId || cell.cell_id) || proposedCellId(clientRequestId);
        delete cell.cell_id;
        payload = Object.keys(object(payload.cell)).length ? { ...payload, cell } : cell;
      }
      const proposal = await provider().createProposal({
        root,
        proposal: {
          clientRequestId,
          workstreamId: valueString(candidate.workstreamId || candidate.workstream_id),
          kind,
          payload,
          proposedBy: "agent:pi:supervisor",
          sourceAdapter: "pi-supervisor-hook",
        },
      });
      return { root, proposal };
    },

    async proposal(body = {}) {
      const root = await rootFor(body);
      return { root, proposal: await provider().proposal({ root, id: valueString(body.id || body.proposalId || body.proposal_id) }) };
    },

    async proposals(body = {}) {
      const root = await rootFor(body);
      const proposals = await provider().proposals({
        root,
        workstreamId: valueString(body.workstreamId || body.workstream_id),
        status: valueString(body.status),
        limit: Math.min(1000, Math.max(1, Number(body.limit) || 200)),
      });
      return { root, proposals };
    },

    async reviewProposal(body = {}) {
      const root = await rootFor(body);
      const proposalId = valueString(body.proposalId || body.proposal_id || body.id);
      const decision = valueString(body.decision);
      const expectedVersion = Number(body.expectedVersion || body.expected_version) || 0;
      const reviewedBy = valueString(body.reviewedBy || body.reviewed_by) || "human:local";
      const editedPayload = body.editedPayload ?? body.edited_payload;
      let proposal = await provider().proposal({ root, id: proposalId });
      let reviewedPayload = editedPayload && typeof editedPayload === "object" && !Array.isArray(editedPayload)
        ? structuredClone(editedPayload) : structuredClone(object(proposal.payload));
      let acceptedRef = "";
      let materialized = null;
      if (decision === "accept" && valueString(proposal.kind) === "cell.create") {
        if (["accepting", "accepted"].includes(valueString(proposal.status))) {
          reviewedPayload = editedPayload && typeof editedPayload === "object" && !Array.isArray(editedPayload)
            ? structuredClone(editedPayload)
            : structuredClone(Object.keys(object(proposal.reviewedPayload)).length
              ? object(proposal.reviewedPayload) : object(proposal.payload));
        }
        let spec = proposalDocument(reviewedPayload, "cell");
        let file = await projectFile(root, valueString(spec.file));
		if (!isResearchDocumentPath(file.path)) {
          throw researchError("A cell Proposal must target a repository .noema work document", 422, "ERR_RESEARCH_PROPOSAL");
        }
        let expectedRevision = valueString(spec.expectedRevision || spec.expected_revision);
        let notebookId = valueString(spec.notebookId || spec.notebook_id);
        let cellId = valueString(spec.cellId || spec.cell_id);
        if (!expectedRevision || !notebookId.startsWith("nb_") || !cellId) {
          throw researchError("A cell Proposal requires expectedRevision, notebookId and deterministic cellId", 422, "ERR_RESEARCH_PROPOSAL");
        }
        let loaded = await readResearchNotebookFile(file.path);
        let currentNotebookId = valueString(researchMeta({ metadata: loaded.notebook.metadata }).notebook_id);
        if (currentNotebookId !== notebookId) {
          throw researchError("Cell Proposal notebook identity does not match its target file", 409, "ERR_RESEARCH_PROPOSAL");
        }

        if (valueString(proposal.status) === "accepted") {
          const frozenPayload = Object.keys(object(proposal.reviewedPayload)).length
            ? object(proposal.reviewedPayload) : object(proposal.payload);
          if (editedPayload && typeof editedPayload === "object" && !Array.isArray(editedPayload)
            && !sameJSONObject(editedPayload, frozenPayload)) {
            throw researchError("The cell Proposal was already accepted with a different reviewed payload", 409, "ERR_RESEARCH_PROPOSAL");
          }
          spec = proposalDocument(frozenPayload, "cell");
          file = await projectFile(root, valueString(spec.file));
          loaded = await readResearchNotebookFile(file.path);
          notebookId = valueString(spec.notebookId || spec.notebook_id);
          cellId = valueString(spec.cellId || spec.cell_id);
          const existingAccepted = cellById(loaded.notebook, cellId);
          if (!materializedCellMatches(loaded.notebook, existingAccepted, spec)) {
            throw researchError("The accepted cell Proposal no longer matches its notebook materialization", 409, "ERR_RESEARCH_PROPOSAL");
          }
          return { root, proposal, materialized: { file: file.path, revision: loaded.revision, cell: existingAccepted, reconciled: true } };
        }

        const existingBeforeReservation = cellById(loaded.notebook, cellId);
        if (existingBeforeReservation) {
          if (!materializedCellMatches(loaded.notebook, existingBeforeReservation, spec)) {
            throw researchError("The proposed cell id already exists with different content", 409, "ERR_RESEARCH_PROPOSAL");
          }
        } else {
          if (loaded.revision !== expectedRevision) {
            throw researchError("Research notebook changed before Proposal acceptance", 409, "ERR_RESEARCH_REVISION");
          }
          // Validate kind, anchor and dependency references on an in-memory
          // clone before the durable reservation. The real write still uses
          // the notebook service's revision compare-and-swap below.
          createResearchCell(loaded.notebook, {
            id: cellId,
            kind: valueString(spec.kind) || "work",
            title: valueString(spec.title),
            source: spec.source ?? "",
            lineageParent: valueString(spec.lineageParent || spec.lineage_parent),
            depends: values(spec.depends),
            after: valueString(spec.after),
          });
        }

        const reservation = await provider().beginProposalAcceptance({
          root,
          review: {
            proposalId,
            expectedVersion,
            reviewedBy,
            ...(reviewedPayload && typeof reviewedPayload === "object" && !Array.isArray(reviewedPayload)
              ? { editedPayload: reviewedPayload } : {}),
          },
        });
        proposal = object(reservation.proposal);
        reviewedPayload = structuredClone(object(proposal.reviewedPayload));
        spec = proposalDocument(reviewedPayload, "cell");
        file = await projectFile(root, valueString(spec.file));
        expectedRevision = valueString(spec.expectedRevision || spec.expected_revision);
        notebookId = valueString(spec.notebookId || spec.notebook_id);
        cellId = valueString(spec.cellId || spec.cell_id);
        loaded = await readResearchNotebookFile(file.path);
        currentNotebookId = valueString(researchMeta({ metadata: loaded.notebook.metadata }).notebook_id);
        if (currentNotebookId !== notebookId) {
          throw researchError("Cell Proposal notebook identity changed after acceptance reservation", 409, "ERR_RESEARCH_PROPOSAL");
        }
        const existing = cellById(loaded.notebook, cellId);
        if (existing) {
          if (!materializedCellMatches(loaded.notebook, existing, spec)) {
            throw researchError("The proposed cell id already exists with different content", 409, "ERR_RESEARCH_PROPOSAL");
          }
          materialized = { file: file.path, revision: loaded.revision, cell: existing, reconciled: true };
        } else {
          if (loaded.revision !== expectedRevision) {
            throw researchError("Research notebook changed before Proposal acceptance", 409, "ERR_RESEARCH_REVISION");
          }
          const notebooks = getNotebookService();
          if (!notebooks?.createCell) {
            throw researchError("research notebook writer is unavailable", 503, "ERR_RESEARCH_PROPOSAL");
          }
          materialized = await notebooks.createCell({
            file: file.path,
            id: cellId,
            kind: valueString(spec.kind) || "work",
            title: valueString(spec.title),
            source: spec.source ?? "",
            lineageParent: valueString(spec.lineageParent || spec.lineage_parent),
            depends: values(spec.depends),
            after: valueString(spec.after),
            expectedRevision,
            actor: reviewedBy,
          });
        }
        acceptedRef = `noema://cell/${notebookId}/${cellId}`;
      }
      const review = await provider().reviewProposal({
        root,
        review: {
          proposalId,
          decision,
          expectedVersion: valueString(proposal.kind) === "cell.create" && decision === "accept"
            ? Number(proposal.version) : expectedVersion,
          reviewedBy,
          reason: valueString(body.reason),
          ...(valueString(proposal.kind) !== "cell.create" && editedPayload && typeof editedPayload === "object" && !Array.isArray(editedPayload)
            ? { editedPayload: reviewedPayload } : {}),
          acceptedRef,
        },
      });
      return { root, ...review, materialized };
    },

    async finding(body = {}) {
      const root = await rootFor(body);
      return { root, finding: await provider().finding({ root, id: valueString(body.id || body.findingId || body.finding_id) }) };
    },

    async findings(body = {}) {
      const root = await rootFor(body);
      const findings = await provider().findings({
        root,
        workstreamId: valueString(body.workstreamId || body.workstream_id),
        status: valueString(body.status),
        query: valueString(body.query),
        limit: Math.min(1000, Math.max(1, Number(body.limit) || 200)),
        includeLocal: Boolean(body.includeLocal ?? body.include_local),
      });
      return { root, findings };
    },

    async researchIR(body = {}) {
      const root = await rootFor(body);
      const versions = await provider().researchIR({ root,
        workstreamId: valueString(body.workstreamId || body.workstream_id),
        limit: Math.min(1000, Math.max(1, Number(body.limit) || 100)),
      });
      return { root, versions };
    },

    async problemModels(body = {}) {
      const root = await rootFor(body);
      const versions = await provider().problemModels({ root,
        workstreamId: valueString(body.workstreamId || body.workstream_id),
        limit: Math.min(1000, Math.max(1, Number(body.limit) || 100)),
      });
      return { root, versions };
    },

    async exportWorkstream(body = {}) {
      const root = await rootFor(body);
      const result = await provider().createWorkstreamExport({
        root,
        export: {
          workstreamId: valueString(body.workstreamId || body.workstream_id),
          exportedBy: valueString(body.exportedBy || body.exported_by) || "human:local",
          includeLocalOnly: Boolean(body.includeLocalOnly ?? body.include_local_only),
        },
      });
      return { root, export: result };
    },

	async createTask(body = {}) {
	  const root = await rootFor(body);
	  const spec = Object.keys(object(body.task)).length ? object(body.task) : object(body.spec);
	  const task = await provider().createTask({ root, task: {
		clientRequestId: valueString(body.clientRequestId || body.client_request_id) || `local-task-${randomUUID()}`,
		workstreamId: valueString(body.workstreamId || body.workstream_id),
		task: structuredClone(spec),
		createdBy: valueString(body.createdBy || body.created_by) || "human:local",
	  }});
	  return { root, task };
	},

	async task(body = {}) {
	  const root = await rootFor(body);
	  return { root, task: await provider().task({ root, id: valueString(body.id || body.taskId || body.task_id) }) };
	},

	async tasks(body = {}) {
	  const root = await rootFor(body);
	  const tasks = await provider().tasks({ root,
		workstreamId: valueString(body.workstreamId || body.workstream_id),
		state: valueString(body.state), limit: Math.min(1000, Math.max(1, Number(body.limit) || 200)),
		includeLocal: Boolean(body.includeLocal ?? body.include_local),
	  });
	  return { root, tasks };
	},

	async transitionTask(body = {}) {
	  const root = await rootFor(body);
	  const nested = Object.keys(object(body.transition)).length ? object(body.transition) : body;
	  const task = await provider().transitionTask({ root, transition: {
		taskId: valueString(nested.taskId || nested.task_id || nested.id), state: valueString(nested.state),
		expectedVersion: Number(nested.expectedVersion || nested.expected_version) || 0,
		changedBy: valueString(nested.changedBy || nested.changed_by) || "human:local",
		reason: valueString(nested.reason),
	  }});
	  return { root, task };
	},

	async createJob(body = {}) {
	  const root = await rootFor(body);
	  const spec = Object.keys(object(body.job)).length ? object(body.job) : object(body.spec);
	  const job = await provider().createJob({ root, job: {
		clientRequestId: valueString(body.clientRequestId || body.client_request_id) || `local-job-${randomUUID()}`,
		workstreamId: valueString(body.workstreamId || body.workstream_id), job: structuredClone(spec),
		createdBy: valueString(body.createdBy || body.created_by) || "human:local",
	  }});
	  return { root, job };
	},

	async job(body = {}) {
	  const root = await rootFor(body);
	  return { root, job: await provider().job({ root, id: valueString(body.id || body.jobId || body.job_id) }) };
	},

	async jobs(body = {}) {
	  const root = await rootFor(body);
	  const jobs = await provider().jobs({ root,
		workstreamId: valueString(body.workstreamId || body.workstream_id),
		taskId: valueString(body.taskId || body.task_id), state: valueString(body.state),
		limit: Math.min(1000, Math.max(1, Number(body.limit) || 200)),
	  });
	  return { root, jobs };
	},

	async registerSchedulerWorker(body = {}) {
	  const root = await rootFor(body);
	  const nested = Object.keys(object(body.worker)).length ? object(body.worker) : body;
	  const worker = await provider().registerSchedulerWorker({ root, worker: {
		id: valueString(nested.id || nested.workerId || nested.worker_id), kind: valueString(nested.kind),
		profile: valueString(nested.profile), transport: valueString(nested.transport),
		capabilities: values(nested.capabilities).map(valueString).filter(Boolean),
		inferenceCapable: Boolean(nested.inferenceCapable ?? nested.inference_capable), state: valueString(nested.state),
	  }});
	  return { root, worker };
	},

	async schedulerWorkers(body = {}) {
	  const root = await rootFor(body);
	  const workers = await provider().schedulerWorkers({ root, state: valueString(body.state),
		limit: Math.min(1000, Math.max(1, Number(body.limit) || 200)) });
	  return { root, workers };
	},

	async claimJob(body = {}) {
	  const root = await rootFor(body);
	  const nested = Object.keys(object(body.claim)).length ? object(body.claim) : body;
	  const claim = await provider().claimJob({ root, claim: {
		jobId: valueString(nested.jobId || nested.job_id || nested.id),
		workerId: valueString(nested.workerId || nested.worker_id),
		claimRequestId: valueString(nested.claimRequestId || nested.claim_request_id) || `claim-${randomUUID()}`,
		executionMode: valueString(nested.executionMode || nested.execution_mode), ttlMillis: Number(nested.ttlMillis || nested.ttl_millis) || 30000,
		runtime: structuredClone(object(nested.runtime)), resolvedResources: structuredClone(values(nested.resolvedResources || nested.resolved_resources)),
		contextSnapshot: valueString(nested.contextSnapshot || nested.context_snapshot),
		disclosureView: valueString(nested.disclosureView || nested.disclosure_view),
		problemModelVersion: Number(nested.problemModelVersion || nested.problem_model_version) || 0,
		policy: structuredClone(object(nested.policy)),
	  }});
	  return { root, ...claim };
	},

	async startJob(body = {}) {
	  const root = await rootFor(body);
	  const lease = schedulerLease(body);
	  return { root, job: await provider().startJob({ root, lease }) };
	},

	async renewJobLease(body = {}) {
	  const root = await rootFor(body);
	  const lease = { ...schedulerLease(body), ttlMillis: Number(body.ttlMillis || body.ttl_millis) || 30000 };
	  return { root, lease: await provider().renewJobLease({ root, lease }) };
	},

	async expireJobLeases(body = {}) {
	  const root = await rootFor(body);
	  const workstreamId = valueString(body.workstreamId || body.workstream_id);
	  const result = await provider().expireJobLeases({ root, workstreamId });
	  return { root, jobs: values(result.jobs) };
	},

	async completeJob(body = {}) {
	  return finishScheduledJob(body, "complete");
	},

	async failJob(body = {}) {
	  return finishScheduledJob(body, "fail");
	},

	async unresolvedJob(body = {}) {
	  return finishScheduledJob(body, "unresolved");
	},

	async retryJob(body = {}) {
	  const root = await rootFor(body);
	  const nested = Object.keys(object(body.retry)).length ? object(body.retry) : body;
	  const job = await provider().retryJob({ root, retry: {
		jobId: valueString(nested.jobId || nested.job_id || nested.id),
		expectedVersion: Number(nested.expectedVersion || nested.expected_version) || 0,
		requestedBy: valueString(nested.requestedBy || nested.requested_by) || "human:local",
		reason: valueString(nested.reason),
	  }});
	  return { root, job };
	},

	async invocations(body = {}) {
	  const root = await rootFor(body);
	  const invocations = await provider().invocations({ root,
		jobId: valueString(body.jobId || body.job_id), limit: Math.min(1000, Math.max(1, Number(body.limit) || 100)) });
	  return { root, invocations };
	},

	async createDelegation(body = {}) {
	  const root = await rootFor(body);
	  const spec = Object.keys(object(body.delegation)).length ? object(body.delegation) : object(body.spec);
	  const delegation = await provider().createDelegation({ root, delegation: {
		clientRequestId: valueString(body.clientRequestId || body.client_request_id) || `local-delegation-${randomUUID()}`,
		workstreamId: valueString(body.workstreamId || body.workstream_id), delegation: structuredClone(spec),
	  }});
	  return { root, delegation };
	},

	async delegations(body = {}) {
	  const root = await rootFor(body);
	  const delegations = await provider().delegations({ root,
		workstreamId: valueString(body.workstreamId || body.workstream_id),
		parentTaskId: valueString(body.parentTaskId || body.parent_task_id),
		childTaskId: valueString(body.childTaskId || body.child_task_id),
		limit: Math.min(1000, Math.max(1, Number(body.limit) || 200)),
	  });
	  return { root, delegations };
	},

	async orchestrationSnapshot(body = {}) {
	  const root = await rootFor(body);
	  const workstreamId = valueString(body.workstreamId || body.workstream_id);
	  const [tasks, jobs, workers, delegations, proposals, allEvents] = await Promise.all([
		provider().tasks({ root, workstreamId, limit: 1000, includeLocal: true }),
		provider().jobs({ root, workstreamId, limit: 1000 }), provider().schedulerWorkers({ root, limit: 1000 }),
		provider().delegations({ root, workstreamId, limit: 1000 }),
		provider().proposals({ root, workstreamId, limit: 1000 }), provider().events({ root, after: 0, limit: 1000 }),
	  ]);
	  const invocationGroups = await Promise.all(jobs.map(async (job) => ({ jobId: valueString(job.id),
		invocations: await provider().invocations({ root, jobId: valueString(job.id), limit: 100 }) })));
	  return { root, workstreamId, tasks, jobs, workers, delegations, proposals,
		invocations: invocationGroups.flatMap((group) => group.invocations),
		events: allEvents.filter((event) => !workstreamId || valueString(event.workstreamId || event.workstream_id) === workstreamId) };
	},

    async promoteSession(body = {}) {
      const root = await rootFor(body);
      const adapter = String(body.adapter || body.agent || "").trim();
      const nativeSessionId = String(body.nativeSessionId || body.native_session_id || "").trim();
      const executionTarget = resolve(String(body.executionTarget || body.cwd || root));
      return provider().promoteSession({
        root,
        session: {
          workstreamId: String(body.workstreamId || body.workstream_id || ""),
          title: String(body.title || ""),
          goal: String(body.goal || ""),
          adapter,
          transport: String(body.transport || "acp"),
          nativeSessionId,
          executionTarget,
          parentSessionId: String(body.parentSessionId || ""),
          forkMode: String(body.forkMode || ""),
          startedAt: String(body.startedAt || ""),
          capabilities: body.capabilities && typeof body.capabilities === "object" ? body.capabilities : {},
        },
      });
    },

    async sessions(body = {}) {
      const root = await rootFor(body);
      const sessions = await provider().sessions({
        root,
        workstreamId: String(body.workstreamId || ""),
        adapter: String(body.adapter || ""),
        limit: Math.min(1000, Math.max(1, Number(body.limit) || 200)),
      });
      return { root, sessions };
    },

    async session(body = {}) {
      const root = await rootFor(body);
      return { root, session: await provider().session({ root, id: String(body.id || "") }) };
    },

    async takeoverSession(body = {}) {
      const root = await rootFor(body);
      const session = await provider().session({ root, id: valueString(body.sessionId || body.session_id || body.id) });
      const command = manualTUICommand(session);
      const intervention = await provider().beginManualIntervention({
        root,
        intervention: {
          sessionId: session.id, command, startedBy: valueString(body.startedBy || body.started_by) || "emacs",
          expectedVersion: Number(body.expectedVersion || body.expected_version || session.version) || 0,
        },
      });
      return { root, session, intervention, command };
    },

    async handbackSession(body = {}) {
      const root = await rootFor(body);
      const intervention = await provider().endManualIntervention({
        root,
        intervention: {
          interventionId: valueString(body.interventionId || body.intervention_id || body.id),
          endedBy: valueString(body.endedBy || body.ended_by) || "emacs",
          reason: valueString(body.reason), expectedVersion: Number(body.expectedVersion || body.expected_version) || 0,
        },
      });
      return { root, intervention };
    },

    async indexHistory(body = {}) {
      const root = await rootFor(body);
      const sources = Array.isArray(body.sources) && body.sources.length > 0
        ? body.sources
        : await historySources(root);
      if (sources.length === 0) {
        throw researchError("No native history directories are available", 404, "ERR_RESEARCH_HISTORY_SOURCE");
      }
      return { root, ...(await provider().indexHistory({ root, sources })) };
    },

    async searchHistory(body = {}) {
      const root = await rootFor(body);
      const hits = await provider().searchHistory({
        root,
        query: String(body.query || ""),
        projectRoot: String(body.projectRoot || root),
        source: String(body.source || ""),
        limit: Math.min(100, Math.max(1, Number(body.limit) || 20)),
      });
      return { root, hits };
    },

    async peekHistory(body = {}) {
      const root = await rootFor(body);
      return {
        root,
        record: await provider().peekHistory({
          root,
          id: String(body.id || ""),
          maxRunes: Math.min(8000, Math.max(1, Number(body.maxRunes) || 1200)),
        }),
      };
    },

    async readHistory(body = {}) {
      const root = await rootFor(body);
      return { root, record: await provider().readHistory({ root, id: String(body.id || "") }) };
    },
  };
}
