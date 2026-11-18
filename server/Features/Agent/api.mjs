import { randomUUID } from "node:crypto";
import { scanEdiffBlocks, ediffSide } from "../../../shared/ediff-source.mjs";
import { listAgentSkills, readAgentSkill } from "../../lib/agent-skills.mjs";
import { agentMemorySearch, agentProjectMaintain, agentProjectStatus } from "../../lib/agent-project.mjs";
import { projectGraph } from "../../lib/project-graph.mjs";
import { piWatch } from "../../lib/pi-watch.mjs";
import { exploration, modelDuplicateCheck } from "../../lib/exploration.mjs";
import { leanJudge } from "../../lib/lean-judge.mjs";
import { callOneTool } from "../../lib/pi-model.mjs";
import { join } from "node:path";
import { fullChannel } from "../../lib/agent-api-client.mjs";
import { proposeSuggestions } from "../../lib/collab-suggestions.mjs";
import { commentAnchor, newCommentId } from "../../../shared/comment-anchors.mjs";
import { createThread, setThreadStatus } from "../../lib/note-comments.mjs";
import { largeChange, resolveEdits } from "../../lib/edit-forms.mjs";

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

function proposal(title, oldText, newText, author) {
  if (oldText === newText) bad("A proposal must change the text");
  const label = String(title || "Proposed edit").trim();
  if (/[\r\n]/.test(label)) bad("Proposal title must be one line");
  if (scanEdiffBlocks(newText).length) bad("Proposals cannot contain nested review blocks");
  const by = author ? `@@ediff-author ${JSON.stringify(author)}\n` : "";
  return `#+begin ediff ${label}\n${by}${diffLines(oldText, "-")}${diffLines(newText, "+")}#+end ediff\n`;
}

/** Past these a card stops being reviewable; the refusal names the way out. */
const MAX_PROPOSAL_CARDS = 12;
const MAX_CARD_CHANGED_LINES = 60;
const MAX_DIFF_CELLS = 4_000_000;

const keepEnds = (text) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

/** Changed line runs of OLD against NEXT as {from,to,oldText,newText}, offsets into OLD. */
export function lineHunks(oldText, newText) {
  const a = keepEnds(oldText), b = keepEnds(newText);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const n = a.length - head - tail, m = b.length - head - tail;
  const matches = [];
  if (n && m && n * m <= MAX_DIFF_CELLS) {
    const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
      lcs[i][j] = a[head + i] === b[head + j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    for (let i = 0, j = 0; i < n && j < m;) {
      if (a[head + i] === b[head + j]) matches.push([head + i++, head + j++]);
      else if (lcs[i + 1][j] >= lcs[i][j + 1]) i++;
      else j++;
    }
  }
  matches.push([a.length - tail, b.length - tail]);
  const spans = [];
  let i = head, j = head;
  for (const [x, y] of matches) {
    if (x > i || y > j) {
      const last = spans.at(-1);
      // One unchanged line between two changes reads better inside one card.
      if (last && i - last.i2 <= 1) { last.i2 = x; last.j2 = y; }
      else spans.push({ i1: i, i2: x, j1: j, j2: y });
    }
    i = x + 1; j = y + 1;
  }
  const offsets = [0];
  for (const line of a) offsets.push(offsets.at(-1) + line.length);
  return spans.map(({ i1, i2, j1, j2 }) => ({ from: offsets[i1], to: offsets[i2],
    oldText: a.slice(i1, i2).join(""), newText: b.slice(j1, j2).join("") }));
}

/** The edits of a request: `content` is the whole new document, costing one copy, not two. */
function requestedEdits(source, { edits, content }) {
  if (content === undefined) return edits;
  if (typeof content !== "string") bad("content must be the whole new document as a string");
  if (edits !== undefined) bad("Give edits or content, not both");
  return [{ from: 0, to: source.length, oldText: source, newText: content }];
}

function tooLarge(detail) {
  bad(`${detail} is too much to review as cards. If the person asked for this change, apply it with agent:document:edit; otherwise propose only the few changes that need their judgement.`);
}

/** Apply EDITS directly. A pending proposal is the person's to decide, so none is touched. */
export function editMarkdown(source, edits) {
  if (!Array.isArray(edits) || !edits.length) bad("edits must be a non-empty array");
  const blocks = scanEdiffBlocks(source);
  const changes = edits.map((edit) => {
    const from = position(source, edit.from);
    const to = position(source, edit.to);
    if (from === undefined || to === undefined || to < from) bad("Each edit needs an ordered from/to range");
    if (typeof edit.oldText !== "string" || source.slice(from, to) !== edit.oldText)
      bad("oldText differs from the saved source; read it again");
    if (typeof edit.newText !== "string") bad("newText must be a string");
    if (blocks.some((block) => from < block.end && to > block.from))
      bad("A pending proposal is in this range; it is the person's to accept or reject");
    return { from, to, insert: edit.newText };
  }).sort((a, b) => a.from - b.from);
  for (let i = 1; i < changes.length; i++)
    if (changes[i].from < changes[i - 1].to) bad("Edits overlap");
  let result = source;
  for (const change of changes.reverse()) result = result.slice(0, change.from) + change.insert + result.slice(change.to);
  if (result === source) bad("The edit changes nothing");
  return result;
}

/** Build review source, retaining the original old side when revising feedback.
 * A new edit is split into one card per changed run: unchanged lines stay out. */
export function proposeMarkdown(source, edits, author) {
  if (!Array.isArray(edits) || !edits.length) bad("edits must be a non-empty array");
  const blocks = scanEdiffBlocks(source);
  const changes = edits.flatMap((edit) => {
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
      return [{ from, to, insert: proposal(edit.title || block.title, ediffSide(block, "old"), edit.newText,
        block.author ?? author) }];
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
    const region = source.slice(start, end);
    if (region === next) bad("A proposal must change the text");
    return lineHunks(region, next).map((hunk) => {
      const changed = keepEnds(hunk.oldText).length + keepEnds(hunk.newText).length;
      if (changed > MAX_CARD_CHANGED_LINES) tooLarge(`One card of ${changed} changed lines`);
      return { from: start + hunk.from, to: start + hunk.to, insert: proposal(edit.title, hunk.oldText, hunk.newText, author) };
    });
  }).sort((a, b) => a.from - b.from);
  if (changes.length > MAX_PROPOSAL_CARDS) tooLarge(`${changes.length} separate changes`);
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

const apiAreas = (channels) => Object.fromEntries(Map.groupBy(channels, (name) => name.split(":")[2]).entries()
  .map(([area, names]) => [area, names.length]));

// Pristine Lean types, one file per frozen text, under Emacs var/.
const leanJudgeCache = join(import.meta.dirname, "../../../../../var/noema/lean-judge");

export function createAgentApiHandlers({ router, call, onComment = () => {}, onNeedsPerson = () => {} }) {
  const documented = (handler, apiDoc) => Object.assign(handler, { apiDoc });
  // An exploration's members are Emacs sessions; Lean and one model call judge.
  const explorationDeps = { call, duplicate: modelDuplicateCheck(callOneTool),
    judge: (body) => leanJudge(body, { cache: leanJudgeCache }) };
  // Without a version, each edit's oldText is the check: it must match at its position.
  // The collaborator behind a call, named by Emacs from the session token its
  // API client sends; an unreachable Emacs still leaves an attributable card.
  const authorOf = async (session) => {
    if (typeof session !== "string" || !session) return undefined;
    try {
      const reply = await call("noema:api:emacs:agent", [{ action: "identify", session }]);
      const name = reply?.session?.name;
      return { name: typeof name === "string" && name ? name : "agent", session };
    } catch { return { name: "agent", session }; }
  };
  /** Refuse a change the person should see, and tell them which session asks (C74). */
  const needsPerson = (file, authorSession, reason) => {
    onNeedsPerson({ file, session: authorSession ?? null, reason });
    return { ok: false, needsPerson: true, message: `${reason} This is for the person: they have been told and will open your session. Do not retry it.` };
  };
  const changedLines = (before, after) => lineHunks(before, after)
    .reduce((sum, hunk) => sum + keepEnds(hunk.oldText).length + keepEnds(hunk.newText).length, 0);
  const saveDocument = async ({ file, baseVersion, edits, content: whole, authorSession, allowLarge } = {}, transform, client) => {
    if (baseVersion !== undefined && (typeof baseVersion !== "string" || !baseVersion)) bad("baseVersion must be a document:read version");
    if (typeof file !== "string" || !file.startsWith("/")) bad("An absolute saved file is required");
    const markdown = /\.(md|markdown)$/i.test(file);
    if (!markdown && client === "agent-proposal") {
      if (whole !== undefined) bad("A suggestion for a file that is not Markdown takes edits, not content");
      const suggestions = await proposeSuggestions({ file, edits, author: await authorOf(authorSession),
        resolve: (source, value) => position(source, value) });
      return { ok: true, suggestion: suggestions[0], suggestions };
    }
    if (!markdown) bad("A saved Markdown file is required; for other files use agent:file:edit or propose a suggestion");
    const author = client === "agent-proposal" ? await authorOf(authorSession) : undefined;
    // The person may type meanwhile: edits that name their text rebase onto
    // the latest version, so a lost save race is simply tried again.
    for (let attempt = 0; attempt < 3; attempt++) {
      const opened = await call("noema:api:notes:open", [file]);
      if (baseVersion !== undefined && opened?.version !== baseVersion) return { ok: false, conflict: true, version: opened?.version, message: "Document changed; read it again before revising" };
      const requested = requestedEdits(opened.content, { edits, content: whole });
      const content = transform(opened.content, resolveEdits(opened.content, requested, position), author);
      if (client === "agent-edit" && allowLarge !== true && largeChange(opened.content, content, changedLines(opened.content, content)))
        return needsPerson(file, authorSession, `This edit rewrites most of ${file.split("/").pop()}.`);
      const saved = await call("noema:api:notes:save", [{ file: opened.file || file, content, baseVersion: opened.version,
        clientId: `${client}-${randomUUID()}`, seq: 1, mode: "source", refresh: "deferred" }]);
      if (!saved?.conflict || baseVersion !== undefined) return saved;
    }
    return needsPerson(file, authorSession, "The note kept changing while this edit was saved.");
  };
  // A text file that is not a note (C74), through Emacs so an open buffer,
  // unsaved edits included, is what changes.
  const editFile = async (body = {}) => {
    const { file, edits, content: whole, authorSession, allowLarge } = body;
    if (typeof file !== "string" || !file.startsWith("/")) bad("An absolute file is required");
    if (/\.(md|markdown)$/i.test(file)) return saveDocument(body, editMarkdown, "agent-edit");
    for (let attempt = 0; attempt < 3; attempt++) {
      const read = await call("noema:api:emacs:text", [{ action: "read", file }]);
      if (!read || read.ok === false) return read ?? { ok: false, message: "Emacs could not read the file" };
      const source = String(read.content ?? "");
      const resolved = resolveEdits(source, requestedEdits(source, { edits, content: whole }), position);
      const after = editMarkdown(source, resolved);
      if (allowLarge !== true && largeChange(source, after, changedLines(source, after)))
        return needsPerson(file, authorSession, `This edit rewrites most of ${file.split("/").pop()}.`);
      // Emacs counts characters, not UTF-16 units.
      const cp = (offset) => Array.from(source.slice(0, offset)).length;
      const applied = await call("noema:api:emacs:text", [{ action: "apply", file, version: read.version,
        edits: resolved.map((edit) => ({ from: cp(edit.from), to: cp(edit.to), oldText: edit.oldText, newText: edit.newText })) }]);
      if (!applied?.conflict) return applied;
    }
    return needsPerson(file, authorSession, "The file kept changing while this edit was applied.");
  };
  // An agent's comment (C71): wrap the text it names in an anchor through the
  // canonical save, so an open page follows, then open its thread; or reply.
  // A comment of the person's (C80) is a task: an agent marks it done when the
  // change is made, or opens a comment of its own on the text it names.  There
  // are no replies: the work is the change to the file.
  const commentDocument = async ({ file, id, text, from, to, oldText, resolve, authorSession } = {}) => {
    if (typeof file !== "string" || !/\.(md|markdown)$/i.test(file)) bad("A saved Markdown file is required");
    if (id) {
      if (typeof text === "string" && text.trim()) bad("Comments take no replies: make the change through document:edit, then mark the comment done");
      const thread = await setThreadStatus({ file, id, resolved: resolve !== false });
      onComment(file);
      return { ok: true, thread };
    }
    if (typeof text !== "string" || !text.trim()) bad("A comment needs text");
    const who = await authorOf(authorSession);
    const author = { name: who?.name ?? "agent", kind: "agent", ...(who?.session ? { session: who.session } : {}) };
    const opened = await call("noema:api:notes:open", [file]);
    const start = position(opened.content, from), end = position(opened.content, to);
    if (start === undefined || end === undefined || end <= start) bad("A comment needs an ordered from/to range");
    if (typeof oldText !== "string" || opened.content.slice(start, end) !== oldText) bad("oldText differs from the saved source; read it again");
    const threadId = newCommentId();
    const anchored = opened.content.slice(0, start) + commentAnchor(oldText, threadId) + opened.content.slice(end);
    const thread = await createThread({ file: opened.file || file, id: threadId, quote: oldText, text, author });
    onComment(opened.file || file);
    const saved = await call("noema:api:notes:save", [{ file: opened.file || file, content: anchored, baseVersion: opened.version,
      clientId: `agent-comment-${randomUUID()}`, seq: 1, mode: "source", refresh: "deferred" }]);
    return { ok: saved?.ok !== false, thread, ...(saved?.ok === false ? { save: saved } : {}) };
  };
  return {
    "noema:api:agent:document:comment": documented((body) => commentDocument(body), {
      description: "Comments are tasks. With id, mark that comment done once its change is made (resolve:false reopens it); comments take no replies. Without id, comment on the text you name, for a question to the person, not for a change (that is document:edit or propose).",
      parameters: [{ file: "absolute Markdown path", from: "UTF-16 offset or {line,column}", to: "end, same form",
        oldText: "the exact text from..to (one line)", text: "a new comment", id: "the comment to mark done",
        resolve: "optional false with id: reopen" }] }),
    "noema:api:agent:skill:list": documented((body) => listAgentSkills(body), {
      description: "Read the existing Skill/Packs manager's effective catalog. Packs marked agent_catalog there are the default; no Skill body is returned.",
      parameters: [{ root: "optional absolute project root", scope: "global or project", requestedSkills: "optional explicit ids", requestedPacks: "optional existing pack ids" }],
    }),
    "noema:api:agent:skill:read": documented((body) => readAgentSkill(body), {
      description: "Read one effective Skill with project patches and dependencies; explicit disables remain authoritative. No task is executed.",
      parameters: [{ id: "Skill id", root: "optional absolute project root", scope: "global or project" }],
    }),
    "noema:api:agent:project:status": documented((body) => agentProjectStatus(body, { call }), {
      description: "Read a Project's shared resources: root, workspace, the `.agent/` cache's size and pressure, the task graph, Pi's watches, its explorations and Hy Memory's state. Starts nothing and creates no Project or store.",
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
    "noema:api:agent:pi:watch": documented((body) => piWatch(body), {
      description: "Work that outlives your turn: after a countdown, on a repeat, or on a task graph event, tell Pi or a session, or run a Project script. Kept in `.agent/pi/`; they run while the Project's Pi runs and otherwise wait, as `running` says. The noema-pi Skill says when to use it.",
      parameters: [{ root: "absolute path in the Project", op: "list (default) | add | cancel", agent: "add: who is asking", why: "add: what this is for",
        when: "add: exactly one of {after:'20m'} {every:'10m',times} {on:{kind,task,agent}} {on:{task,phase}}",
        do: "add: {prompt, to?: 'pi'|'companion'|{buffer,nativeSessionId}} or {script: Project file, args?: strings, report?: same as to}",
        id: "cancel; optional name on add" }],
    }),
    "noema:api:agent:exploration": documented((body) => exploration(body, explorationDeps), {
      description: "Several background Agents work one mathematical problem at once, each on a direction no other holds; the session that starts it judges their reports. Its Markdown lives in the Project's `explorations/<id>/`: problem.md, one notebook per member, summary.md. Starter: start, status, board, verdict, stop, resume, list. Member: board, register, post, abandon, submit. With a Lean statement, Lean verifies a proof before the judge hears of it. Agents with a shell can run scripts/exploration.mjs.",
      parameters: [{ root: "absolute path in the Project", op: "status (default) | board | list | start | verdict | stop | resume | register | post | abandon | submit", id: "the exploration, except for start and list",
        coordinator: "start: {buffer, nativeSessionId} of the judging session (yours)", title: "start", note: "start: absolute Markdown file stating the problem", problem: "start: the problem as text, instead of or beside note",
        standard: "start: what a solution must meet", lean: "start: absolute .lean frozen statement (theorem := sorry); Lean then verifies every proof", members: "start: 1..8, default 4", minutes: "start/resume: 10..1440, default 120",
        agent: "start: provider id, default the coordinator's", modelId: "start: optional", effort: "start: optional", member: "member operations and verdict: m1, m2, …", text: "register/post", kind: "post: lemma | partial | counterexample | dead-end | note",
        reason: "abandon, and verdict when rejecting", report: "submit: at most 1500 bytes", files: "submit: files inside the exploration's directory", proof: "submit: the Lean proof file when the judge is Lean",
        accept: "verdict: true or false", finish: "verdict: true ends the exploration solved", by: "verdict/stop: person when a person decides" }],
    }),
    "noema:api:agent:lean:judge": documented((body) => leanJudge(body, { cache: leanJudgeCache }), {
      description: "Lean decides whether a proof proves a frozen statement: the person's .lean file with one `theorem NAME … := sorry`. statement vets that file; check grades a partial proof (invalid, errors, sorries, complete); verify decides a solve (statement and preamble kept byte for byte, Lean elaborates, axioms only propext/Classical.choice/Quot.sound, pp.all type equal). Runs `lake env lean` in the nearest Lake project; takes minutes. Agents with a shell can run scripts/lean-judge.mjs.",
      parameters: [{ op: "statement | check | verify (default)", statement: "absolute frozen .lean file", candidate: "absolute proof .lean file (check, verify)", lake: "optional Lake project directory", timeoutMs: "optional, default 300000" }],
    }),
    "noema:api:agent:memory:search": documented((body) => agentMemorySearch(body), {
      description: "Search Hy Memory in the Project's scope with a query of your own; ordinary turns already recall by their prompt. `state` other than ok means unknown, not empty. Results are unverified background.",
      parameters: [{ root: "absolute path in the Project", query: "what to recall" }],
    }),
    "noema:api:agent:discover": documented(({ query = "", offset = 0, limit } = {}) => {
      if (!Number.isSafeInteger(offset) || offset < 0 || limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 50))
        bad("offset >= 0; limit 1..50");
      const channels = router.search(query);
      // An alphabetical page of 346 names answers nothing: without words, show the areas.
      if (!String(query).trim() && limit === undefined) return { total: channels.length, areas: apiAreas(channels) };
      const size = limit ?? 12;
      return { total: channels.length, channels: channels.slice(offset, offset + size),
        nextOffset: offset + size < channels.length ? offset + size : null };
    }, { description: "Search live API names, descriptions and aliases; returns only matching names, never all schemas or implementations. Name matches rank first. With no words and no limit, returns each area's channel count.", parameters: [{ query: "optional words, e.g. emacs open file or 打开文件", offset: "optional integer", limit: "optional 1..50" }] }),
    "noema:api:agent:describe": documented(({ channel, source = false } = {}) => {
      const name = fullChannel(channel);
      const { implementation, ...doc } = router.describe(name);
      // Named fields are the contract; only an undocumented handler is its own.
      const contract = typeof doc.parameters?.[0] === "object";
      return { ...doc, ...(source || !contract ? { implementation } : {}), agentCallable: !humanDecisions.has(name),
        ...(humanDecisions.has(name) ? { audience: "human", reason: "Human permission/answer/review decision" } : {}) };
    }, {
      description: "Inspect one API's positional contract, with its implementation when its fields are not listed. Existing authorization and runtime checks apply.",
      parameters: [{ channel: "registered channel name", source: "optional: true also returns the implementation" }],
    }),
    "noema:api:agent:call": documented(({ channel: given, args = [] } = {}) => {
      const channel = fullChannel(given);
      if (typeof channel !== "string" || !Array.isArray(args))
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
      // A handler reading fields from anything else would see none and run its default.
      const [first, ...others] = router.has(channel) ? router.describe(channel).parameters ?? [] : [];
      if (first && typeof first === "object" && !others.length && args.length
          && (args.length !== 1 || !args[0] || typeof args[0] !== "object" || Array.isArray(args[0])))
        bad(`${channel} takes one object: args=[{"${Object.keys(first)[0]}":...}]`);
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
    "noema:api:agent:document:propose": documented((body) => saveDocument(body, proposeMarkdown, "agent-proposal"), { description: "Create or revise in-place review cards for the few changes the person should weigh; each changed run becomes its own card, and a request too large to review is refused in favour of document:edit. Never accepts proposals. Preserves unselected text and the original side; clears resolved feedback on revision. Conflicts require rereading, never force/retry a mutation blindly.",
      parameters: [{ file: "absolute Markdown path", baseVersion: "optional document:read version; without it oldText alone guards each edit",
        edits: "[{from,to,oldText,newText,title?}]; UTF-16 offsets or line/column positions. Existing proposals must use their whole from/end range; newText is the replacement proposed side.", content: "instead of edits: the whole new document" }] }),
    "noema:api:agent:document:edit": documented((body) => saveDocument(body, editMarkdown, "agent-edit"), { description: "Apply a change the person asked for directly, through the canonical save and UI notification path, so an open page updates at once and only where it changed. Edits name their text, so they land on the newest version even while the person types; a lost race is retried. Pending proposals in the range are refused, not touched. A change rewriting most of the note is refused and the person is told (needsPerson): do not retry it.",
      parameters: [{ file: "absolute Markdown path", baseVersion: "optional document:read version; use it with content so a concurrent edit is not overwritten",
        edits: "[E]: {oldText,newText} (oldText unique), {lines:[a,b],newText}, {after|before:LINE_TEXT,newText}, {append:TEXT}, or {from,to,oldText,newText}",
        content: "instead of edits: the whole new document", allowLarge: "true only after the person said so in your chat" }] }),
    "noema:api:agent:file:edit": documented((body) => editFile(body), { description: "Change any text file the way document:edit changes a note: the same edit forms, applied through Emacs to its open buffer when there is one (unsaved edits are kept and not saved for the person), otherwise to the file. A note goes to document:edit.",
      parameters: [{ file: "absolute path", edits: "as document:edit", content: "instead of edits: the whole new text", allowLarge: "true only after the person said so" }] }),
  };
}
