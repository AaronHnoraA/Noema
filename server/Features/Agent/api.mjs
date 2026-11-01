import { randomUUID } from "node:crypto";
import { scanEdiffBlocks, ediffSide } from "../../../shared/ediff-source.mjs";
import { listAgentSkills, readAgentSkill } from "../../lib/agent-skills.mjs";
import { agentMemorySearch, agentProjectMaintain, agentProjectStatus } from "../../lib/agent-project.mjs";
import { projectGraph } from "../../lib/project-graph.mjs";

const bad = (message) => { throw Object.assign(new Error(message), { statusCode: 400 }); };
const humanDecisions = new Set([
  "noema:api:research:permission:decide",
  "noema:api:research:input:respond",
  "noema:api:research:proposal:review",
]);

function position(source, value, fallback) {
  if (value === undefined) return fallback;
  if (Number.isSafeInteger(value) && value >= 0 && value <= source.length) return boundary(source, value);
  if (!value || !Number.isSafeInteger(value.line) || value.line < 1
      || !Number.isSafeInteger(value.column) || value.column < 0) bad("Use UTF-16 offsets or {line: 1-based, column: 0-based}");
  let start = 0;
  for (let line = 1; line < value.line; line++) {
    const end = source.indexOf("\n", start);
    if (end < 0) bad("Line is outside the document");
    start = end + 1;
  }
  const end = source.indexOf("\n", start);
  if (value.column > (end < 0 ? source.length : end) - start) bad("Column is outside the line");
  return boundary(source, start + value.column);
}

function boundary(source, offset) {
  if (offset > 0 && /[\uD800-\uDBFF]/.test(source[offset - 1]) && /[\uDC00-\uDFFF]/.test(source[offset] || ""))
    bad("Range cannot split a UTF-16 surrogate pair");
  return offset;
}

function diffLines(text, prefix) {
  if (!text) return "";
  const newline = text.endsWith("\n");
  const lines = text.split("\n");
  if (newline) lines.pop();
  return lines.map((line) => prefix + line + "\n").join("")
    + (newline ? "" : "\\ No newline at end of file\n");
}

function proposal(title, oldText, newText) {
  if (oldText === newText) bad("A proposal must change the text");
  const label = String(title || "Proposed edit").trim();
  if (/[\r\n]/.test(label)) bad("Proposal title must be one line");
  if (scanEdiffBlocks(newText).length) bad("Proposals cannot contain nested review blocks");
  return `#+begin ediff ${label}\n${diffLines(oldText, "-")}${diffLines(newText, "+")}#+end ediff\n`;
}

/** Build review source, retaining the original old side when revising feedback. */
export function proposeMarkdown(source, edits) {
  if (!Array.isArray(edits) || !edits.length) bad("edits must be a non-empty array");
  const blocks = scanEdiffBlocks(source);
  const changes = edits.map((edit) => {
    const from = position(source, edit.from);
    const to = position(source, edit.to);
    if (from === undefined || to === undefined || to < from) bad("Each edit needs an ordered from/to range");
    if (typeof edit.oldText !== "string" || source.slice(from, to) !== edit.oldText)
      bad("oldText differs from the selected saved source; read it again");
    if (typeof edit.newText !== "string") bad("newText must be a string");
    const overlaps = blocks.filter((block) => from < block.end && to > block.from
      || from === to && from >= block.from && from < block.end);
    if (overlaps.length) {
      const block = overlaps[0];
      if (overlaps.length !== 1 || from !== block.from || to !== block.end || block.error)
        bad("Revise an existing proposal using its whole from/end range");
      if (to < source.length && edit.newText && !edit.newText.endsWith("\n"))
        bad("A proposal before another line must retain its final newline");
      return { from, to, insert: proposal(edit.title || block.title, ediffSide(block, "old"), edit.newText) };
    }
    const start = from === 0 ? 0 : source.lastIndexOf("\n", from - 1) + 1;
    let end = to > from && source[to - 1] === "\n" ? to : source.indexOf("\n", to) + 1;
    if (end === 0) end = source.length;
    let next = source.slice(start, from) + edit.newText + source.slice(to, end);
    // A removed line break joins the following line. Include that line so the
    // shared review grammar never needs a mid-document no-newline marker.
    if (end < source.length && next && !next.endsWith("\n")) {
      const nextEnd = source.indexOf("\n", end);
      const extended = nextEnd < 0 ? source.length : nextEnd + 1;
      next += source.slice(end, extended);
      end = extended;
    }
    if (blocks.some((block) => start < block.end && end > block.from))
      bad("Expanded line range touches another proposal; revise it explicitly");
    return { from: start, to: end, insert: proposal(edit.title, source.slice(start, end), next) };
  }).sort((a, b) => a.from - b.from);
  for (let i = 1; i < changes.length; i++) {
    if (changes[i].from < changes[i - 1].to || changes[i].from === changes[i - 1].from)
      bad("Edits overlap after line expansion; combine edits on the same line");
  }
  let result = source;
  for (const change of [...changes].reverse()) result = result.slice(0, change.from) + change.insert + result.slice(change.to);
  const invalid = scanEdiffBlocks(result).find((block) => block.error && !blocks.some((old) => old.error === block.error));
  if (invalid) bad(invalid.error);
  return result;
}

export function createAgentApiHandlers({ router, call }) {
  const documented = (handler, apiDoc) => Object.assign(handler, { apiDoc });
  return {
    "noema:api:agent:skill:list": documented((body) => listAgentSkills(body), {
      description: "Read the existing Skill/Packs manager's effective catalog. Packs marked agent_catalog there are the default; no Skill body is returned.",
      parameters: [{ root: "optional absolute project root", scope: "global or project", requestedSkills: "optional explicit ids", requestedPacks: "optional existing pack ids" }],
    }),
    "noema:api:agent:skill:read": documented((body) => readAgentSkill(body), {
      description: "Read one effective Skill with project patches and dependencies; explicit disables remain authoritative. No task is executed.",
      parameters: [{ id: "Skill id", root: "optional absolute project root", scope: "global or project" }],
    }),
    "noema:api:agent:project:status": documented((body) => agentProjectStatus(body, { call }), {
      description: "Read a Project's shared resources: root, workspace, the `.agent/` cache's size and pressure, and Hy Memory's state. Starts nothing and creates no Project or store.",
      parameters: [{ root: "absolute path in the Project" }],
    }),
    "noema:api:agent:project:maintain": documented((body) => agentProjectMaintain(body, { call }), {
      description: "Run the Project cache's conservative maintenance now: expired stream rows, old unregistered objects, WAL checkpoint. Registered artifacts and Session state are never deleted. Check status first; maintenance also runs after Runs.",
      parameters: [{ root: "absolute path in the Project" }],
    }),
    "noema:api:agent:project:graph": documented((body) => projectGraph(body), {
      description: "Read or maintain the Project's task graph in `.agent/tasks/`: task definitions plus an append-only journal. Reads: status, next, check, graph, timeline, show. Writes: plan, claim, release, submit, review, note, state. The noema-project-graph pack is how to use it; agents with a shell can run scripts/project-graph.mjs with no host.",
      parameters: [{ root: "absolute path in the Project", op: "operation, default status", id: "task id", agent: "who is acting; required by claim, release, submit, review, note and state", session: "optional native Session id", tasks: "plan: task definitions", dryRun: "plan: vet only", evidence: "submit: what proves it", verdict: "review: passed or needs_changes", text: "note, review, release or state text", kind: "note: note, decision or commit", refs: "note: commit shas or paths", state: "state: todo, blocked or dropped", take: "claim: take over an expired claim", requestId: "optional key that makes a retried write a no-op", limit: "timeline length" }],
    }),
    "noema:api:agent:memory:search": documented((body) => agentMemorySearch(body), {
      description: "Search Hy Memory in the Project's scope with a query of your own; ordinary turns already recall by their prompt. `state` other than ok means unknown, not empty. Results are unverified background.",
      parameters: [{ root: "absolute path in the Project", query: "what to recall" }],
    }),
    "noema:api:agent:discover": documented(({ query = "", offset = 0, limit = 12 } = {}) => {
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50)
        bad("offset >= 0; limit 1..50");
      const channels = router.search(query);
      return { total: channels.length, channels: channels.slice(offset, offset + limit),
        nextOffset: offset + limit < channels.length ? offset + limit : null };
    }, { description: "Search live API names, descriptions and aliases; returns only matching names, never all schemas or implementations. Name matches rank first.", parameters: [{ query: "optional words, e.g. emacs open file or 打开文件", offset: "optional integer", limit: "optional 1..50" }] }),
    "noema:api:agent:describe": documented(({ channel } = {}) => ({ ...router.describe(channel),
      agentCallable: !humanDecisions.has(channel),
      ...(humanDecisions.has(channel) ? { audience: "human", reason: "Human permission/answer/review decision" } : {}),
    }), {
      description: "Inspect one API's positional contract and actual implementation. Existing authorization and runtime checks apply.",
      parameters: [{ channel: "registered channel name" }],
    }),
    "noema:api:agent:call": documented(({ channel, args = [] } = {}) => {
      if (typeof channel !== "string" || !channel.startsWith("noema:api:") || !Array.isArray(args))
        bad("A registered channel and positional args array are required");
      if (channel === "noema:api:agent:call") bad("Nested Agent API dispatch is not supported");
      if (humanDecisions.has(channel)) throw Object.assign(new Error("This operation records a human decision; Agent access is descriptive only"), { statusCode: 403 });
      // Agent file visits preserve their chat. Direct page calls keep their
      // own placement and native Markdown clone semantics.
      if (channel === "noema:api:emacs:open") {
        const body = typeof args[0] === "string" ? { file: args[0] } : args[0];
        if (!body || typeof body.file !== "string" || !body.file.trim())
          bad("emacs:open requires a file path");
        if (body.placement === undefined && body.newWindow !== true)
          args = [{ ...body, placement: "other" }, ...args.slice(1)];
      }
      return call(channel, args);
    }, { description: "Dispatch an Agent call to the existing backend. Human permission, answer and review decisions remain human-only.",
      parameters: [{ channel: "registered channel", args: "positional JSON array" }] }),
    "noema:api:agent:document:read": documented(async ({ file, range } = {}) => {
      if (typeof file !== "string" || !/\.(md|markdown)$/i.test(file)) bad("A saved Markdown file is required");
      const opened = await call("noema:api:notes:open", [file]);
      if (opened?.ok === false || typeof opened?.content !== "string" || !opened.version)
        bad(opened?.message || "Document could not be read with a version");
      const source = opened.content;
      const from = position(source, range?.from, 0);
      const to = position(source, range?.to, source.length);
      if (to < from) bad("Range is reversed");
      return { file: opened.file || file, version: opened.version, from, to, length: source.length,
        content: source.slice(from, to),
        proposals: scanEdiffBlocks(source).filter((block) => block.from < to && block.end > from)
          .map((block) => ({ from: block.from, end: block.end, title: block.title,
            oldText: source.slice(block.from, block.end), original: ediffSide(block, "old"),
            proposed: ediffSide(block, "new"), comments: block.comments, rejected: block.rejected, error: block.error })) };
    }, { description: "Read current Markdown, its exact version and optional range, including saved review feedback.",
      parameters: [{ file: "absolute Markdown path", range: "optional {from,to}; UTF-16 offsets or {line:1-based,column:0-based}" }] }),
    "noema:api:agent:document:propose": documented(async ({ file, baseVersion, edits } = {}) => {
      if (typeof baseVersion !== "string" || !baseVersion) bad("baseVersion from document:read is required");
      if (typeof file !== "string" || !/\.(md|markdown)$/i.test(file)) bad("A saved Markdown file is required");
      const opened = await call("noema:api:notes:open", [file]);
      if (opened?.version !== baseVersion) return { ok: false, conflict: true, version: opened?.version, message: "Document changed; read it again before revising" };
      const content = proposeMarkdown(opened.content, edits);
      return call("noema:api:notes:save", [{ file: opened.file || file, content, baseVersion,
        clientId: `agent-proposal-${randomUUID()}`, seq: 1, mode: "source", refresh: "deferred" }]);
    }, { description: "Create or revise in-place review proposals through the canonical save and UI notification path. Never accepts proposals. Preserves unselected text and the original side; clears resolved feedback on revision. Conflicts require rereading, never force/retry a mutation blindly.",
      parameters: [{ file: "absolute Markdown path", baseVersion: "document:read version",
        edits: "[{from,to,oldText,newText,title?}]; UTF-16 offsets or line/column positions. Existing proposals must use their whole from/end range; newText is the replacement proposed side." }] }),
  };
}
