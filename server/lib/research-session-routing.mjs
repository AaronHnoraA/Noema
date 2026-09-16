// D-031 deterministic session naming and DAG-derived defaults.
//
// Every agent conversation a user can reach has a project-scoped name.  A work
// block that says nothing inherits one from its lineage: a straight chain
// keeps talking in one conversation, a branch gets its own reconstructed
// child, and `depends' never carries conversation.  This module is pure: it
// decides from the document, prior Runs and the name registry, and never
// calls a model.

import { researchDependencies, researchError, researchWorkNodes, researchWorkNodeForCell } from "./research-notebook.mjs";
import { parseResearchDirectives } from "./research-directives.mjs";
import { notebookSource } from "./jupyter-notebook-format.mjs";

export const SESSION_KEYWORDS = Object.freeze(["continue", "fork", "fresh"]);
// Words people write for a keyword.  They are refused as names, so a mistyped
// keyword fails loudly instead of silently creating a named session.  Shared
// with Emacs and the Go kernel.
export const SESSION_KEYWORD_LOOKALIKES = Object.freeze({
  refresh: "fresh", renew: "fresh", new: "fresh", reset: "fresh", restart: "fresh",
  resume: "continue", cont: "continue", continued: "continue", same: "continue",
  forked: "fork",
});
export const PI_SESSION_NAME = "pi";
const NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}._/@-]*$/u;

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function nameError(message) {
  return researchError(message, 422, "ERR_RESEARCH_SESSION_NAME");
}

/** Return the keyword VALUE was probably meant to be, or "" for a real name. */
export function sessionKeywordSuggestion(value) {
  const word = text(value).toLowerCase();
  if (SESSION_KEYWORDS.includes(word)) return word;
  return Object.hasOwn(SESSION_KEYWORD_LOOKALIKES, word) ? SESSION_KEYWORD_LOOKALIKES[word] : "";
}

/** Throw unless NAME follows the grammar shared with Go and Emacs. */
export function validateSessionName(name, { allowPi = false } = {}) {
  const value = text(name);
  if (!value) throw nameError("session name is required");
  if ([...value].length > 80) throw nameError(`session name ${value} is longer than 80 characters`);
  if (SESSION_KEYWORDS.includes(value)) throw nameError(`${value} is a reserved @@session keyword, not a name`);
  const meant = sessionKeywordSuggestion(value);
  if (meant) {
    throw nameError(`${value} is not an @@session keyword; did you mean @@session(${meant})? `
      + `Keywords are ${SESSION_KEYWORDS.join(", ")}; any other word names a session`);
  }
  if (value === PI_SESSION_NAME && !allowPi) throw nameError("the pi session belongs to the project coordinator");
  if (!NAME_PATTERN.test(value)) throw nameError(`invalid session name: ${value}`);
  return value;
}

/**
 * Parse one `@@session(...)` value.
 *   continue | fork | fresh      keyword
 *   name                         continue or create NAME
 *   parent:child  /  :child      create CHILD from PARENT (or the derived session)
 */
export function parseSessionDirective(value) {
  const raw = text(value);
  if (!raw) return { kind: "none" };
  if (SESSION_KEYWORDS.includes(raw)) return { kind: "keyword", keyword: raw };
  const colon = raw.indexOf(":");
  if (colon < 0) return { kind: "name", name: validateSessionName(raw) };
  if (raw.indexOf(":", colon + 1) >= 0) throw nameError(`@@session accepts one parent:child pair (got ${raw})`);
  const parent = raw.slice(0, colon).trim();
  const child = validateSessionName(raw.slice(colon + 1));
  return { kind: "fork", parent: parent ? validateSessionName(parent, { allowPi: true }) : "", child };
}

/** Return a readable name fragment from a WorkNode title. */
export function sessionNameSlug(title) {
  const slug = text(title).toLowerCase()
    .replace(/\s+/gu, "-")
    .replace(/[^\p{L}\p{N}._-]/gu, "")
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/-+/g, "-")
    .slice(0, 40)
    .replace(/[-._]+$/u, "");
  return slug && !sessionKeywordSuggestion(slug) && slug !== PI_SESSION_NAME ? slug : "work";
}

function uniqueName(base, taken) {
  if (!taken.has(base)) return base;
  for (let index = 2; ; index += 1) {
    const candidate = `${base}-${index}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function registry(names) {
  const byName = new Map();
  const bySession = new Map();
  const taken = new Set();
  for (const entry of Array.isArray(names) ? names : []) {
    const name = text(entry?.name);
    if (!name) continue;
    byName.set(name, entry);
    taken.add(name);
    for (const alias of Array.isArray(entry.aliases) ? entry.aliases : []) {
      byName.set(text(alias), entry);
      taken.add(text(alias));
    }
    if (text(entry.sessionId)) bySession.set(text(entry.sessionId), entry);
  }
  return { byName, bySession, taken };
}

/**
 * Decide which named conversation WORK-NODE-ID runs in.
 *
 * Returns { action, name, agent, parentName, forkMode, allowNative, origin,
 * rule, fromWorkNodeId, reason, autoContext, legacySessionId } where action is
 * continue | create | fork | adopt (bind a pre-D-031 anonymous session).
 */
export function deriveSessionRoute({
  notebook = null, workNodeId = "", title = "", agent, defaultAgent = "codex", directive = { kind: "none" },
  requestedName = "", runs = [], names = [],
}) {
  const { byName, bySession, taken } = registry(names);
  const nodes = notebook ? researchWorkNodes(notebook) : [];
  const edges = notebook ? researchDependencies(notebook) : [];
  const titleOf = (id) => text(nodes.find((node) => node.id === id)?.title) || (id === workNodeId ? text(title) : "");
  const slug = sessionNameSlug(titleOf(workNodeId) || title);
  const lineageParents = (id) => edges.filter((edge) => edge.to === id && edge.type === "lineage").map((edge) => edge.from);
  if (!text(agent)) {
    const memo = new Map();
    const visiting = new Set();
    const inheritedAgent = (id) => {
      if (memo.has(id)) return memo.get(id);
      if (visiting.has(id)) throw nameError("cyclic lineage cannot determine an agent");
      visiting.add(id);
      const cell = notebook?.cells?.find((candidate) => candidate.cell_type === "code"
        && researchWorkNodeForCell(notebook, candidate)?.id === id);
      let selected = cell ? text(parseResearchDirectives(notebookSource(cell.source)).agent) : "";
      if (!selected) {
        const parents = [...new Set(lineageParents(id).map(inheritedAgent).filter(Boolean))];
        if (parents.length > 1) {
          // Parents disagree.  The document's default agent is an explicit
          // choice that applies to any block without @@agent (DESIGN §5.6),
          // so it settles the merge; without one the choice stays the user's.
          const documentAgent = text(notebook?.metadata?.noema_research?.default_agent);
          if (!documentAgent) throw nameError("lineage parents use different agents; choose @@agent(...) explicitly");
          selected = documentAgent;
        } else {
          selected = parents[0] || "";
        }
      }
      if (!selected) {
        const prior = (Array.isArray(runs) ? runs : []).find((run) => text(run.workNodeId ?? run.work_node_id) === id);
        const entry = prior && (byName.get(text(prior.sessionName)) || bySession.get(text(prior.sessionId ?? prior.session_id)));
        selected = text(entry?.agent || prior?.agent || prior?.adapter);
      }
      visiting.delete(id);
      memo.set(id, selected);
      return selected;
    };
    const namedAgent = directive.kind === "name" ? byName.get(directive.name)?.agent
      : directive.kind === "fork" ? (byName.get(directive.child)?.agent || byName.get(directive.parent)?.agent)
      : byName.get(text(requestedName))?.agent;
    agent = text(namedAgent) || inheritedAgent(workNodeId) || text(defaultAgent) || "codex";
  }

  // Runs arrive newest first.  Index them by WorkNode once, so derivation stays
  // linear in the Run history instead of rescanning it for every node.
  const runsByNode = new Map();
  for (const run of Array.isArray(runs) ? runs : []) {
    const id = text(run?.workNodeId ?? run?.work_node_id);
    if (!id) continue;
    if (!runsByNode.has(id)) runsByNode.set(id, []);
    runsByNode.get(id).push(run);
  }
  // Newest Run of a WorkNode that has a reachable conversation.
  const conversationOf = (id) => {
    for (const run of runsByNode.get(id) || []) {
      const named = byName.get(text(run.sessionName)) || bySession.get(text(run.sessionId ?? run.session_id));
      if (named) return { entry: named };
      if (text(run.sessionId ?? run.session_id)) return { legacySessionId: text(run.sessionId ?? run.session_id) };
    }
    return null;
  };
  const own = workNodeId ? conversationOf(workNodeId) : null;
  const lineage = (() => {
    const seen = new Set([workNodeId]);
    let current = workNodeId;
    let climbed = false;
    while (current) {
      const parents = lineageParents(current).filter((id) => !seen.has(id));
      if (parents.length === 0) return { kind: "root", climbed };
      if (parents.length > 1) return { kind: "merge", at: current };
      const [parent] = parents;
      seen.add(parent);
      climbed = true;
      const found = conversationOf(parent);
      if (found) return { kind: "ancestor", node: parent, ...found };
      current = parent;
    }
    return { kind: "root", climbed };
  })();
  // Every new conversation of a block with upstream blocks sees them, even when
  // no upstream block has run (a question it answers, for example).
  const lineageContext = notebook && workNodeId && lineageParents(workNodeId).length > 0 ? ["lineage"] : [];
  // The document's current lineage is authoritative over where a cell happened
  // to run before.  A cell keeps its own conversation only while it still
  // belongs to the lineage parent's conversation (that session or a fork
  // descended from it).  A conversation acquired through a since-removed
  // @@session, a Pi request, or a Run made before the parent had one must not
  // stay sticky and split a straight chain.
  const lineageEntry = lineage.kind === "ancestor" ? lineage.entry || null : null;
  const sameAgent = (entry) => !entry.agent || entry.agent === agent;
  const descendsFrom = (entry, ancestor) => {
    const seen = new Set();
    for (let current = entry; current && !seen.has(current); current = byName.get(text(current.parentName))) {
      if (current === ancestor) return true;
      seen.add(current);
    }
    return false;
  };
  const lineageHead = Boolean(lineageEntry && sameAgent(lineageEntry)
    && text(lineageEntry.lastRun?.workNodeId) === lineage.node);
  const ownInLineage = Boolean(own?.entry && lineageEntry && descendsFrom(own.entry, lineageEntry));
  // The conversation an explicit continue/fork keyword starts from.
  const base = (() => {
    if (!lineageEntry) return own?.entry || null;
    if (lineageHead || !own?.entry) return lineageEntry;
    if (ownInLineage) return own.entry;
    return sameAgent(lineageEntry) ? lineageEntry : own.entry;
  })();
  const decision = (fields) => ({
    agent, parentName: "", forkMode: "", allowNative: false, origin: "derived",
    fromWorkNodeId: "", autoContext: [], legacySessionId: "", ...fields,
  });
  const create = (name, fields) => decision({ action: "create", name: uniqueName(name, taken), ...fields });
  const fork = (parentEntry, child, fields) => {
    if (parentEntry.agent && parentEntry.agent !== agent && fields.allowNative) fields.allowNative = false;
    return decision({ action: "fork", name: child, parentName: parentEntry.name, forkMode: fields.allowNative ? "native" : "reconstructed", ...fields });
  };
  const continueEntry = (entry, fields) => {
    if (entry.agent && entry.agent !== agent) {
      throw nameError(`session ${entry.name} belongs to agent ${entry.agent}, not ${agent}; use @@session(${entry.name}:new-name) to hand it over`);
    }
    if (entry.state === "archived") throw nameError(`session ${entry.name} is archived; restore it before using it`);
    return decision({ action: "continue", name: entry.name, ...fields });
  };

  const effective = directive.kind === "none" && text(requestedName)
    ? { kind: "name", name: validateSessionName(requestedName), origin: "pi" }
    : { ...directive, origin: "user" };

  switch (effective.kind) {
  case "name": {
    const entry = byName.get(effective.name);
    if (entry) return continueEntry(entry, { origin: effective.origin, rule: "directive-name", reason: `@@session(${effective.name})` });
    return decision({ action: "create", name: effective.name, origin: effective.origin, rule: "directive-name",
      reason: `new session ${effective.name}` });
  }
  case "fork": {
    const existing = byName.get(effective.child);
    if (existing) return continueEntry(existing, { origin: "user", rule: "directive-fork-existing", reason: `${effective.child} already forked; continuing it` });
    const parent = effective.parent ? byName.get(effective.parent) : base;
    if (!parent) {
      throw nameError(effective.parent
        ? `parent session ${effective.parent} does not exist`
        : "no inherited session to fork; name the parent as @@session(parent:child)");
    }
    return fork(parent, effective.child, { origin: "user", allowNative: true, rule: "directive-fork",
      reason: `fork ${parent.name} into ${effective.child}` });
  }
  case "keyword":
    if (effective.keyword === "fresh") {
      return create(slug, { origin: "user", rule: "directive-fresh", reason: "explicit fresh conversation" });
    }
    if (effective.keyword === "fork") {
      if (!base) throw nameError("@@session(fork) needs a prior or inherited session to fork");
      return fork(base, uniqueName(`${base.name}/${slug}`, taken), { origin: "user", allowNative: true,
        rule: "directive-fork", reason: `fork ${base.name}` });
    }
    if (base) {
      return continueEntry(base, { origin: "user", rule: "directive-continue",
        fromWorkNodeId: base === own?.entry ? workNodeId : lineage.node, reason: `continue ${base.name}` });
    }
    if (own?.legacySessionId) {
      return decision({ action: "adopt", name: uniqueName(slug, taken), legacySessionId: own.legacySessionId,
        origin: "user", rule: "directive-continue", reason: "continue the earlier unnamed session" });
    }
    return create(slug, { origin: "user", rule: "directive-continue", reason: "nothing to continue; started a new session" });
  default:
    break;
  }

  const ownRoute = () => {
    if (!sameAgent(own.entry)) {
      return fork(own.entry, uniqueName(`${own.entry.name}@${agent}`, taken), { rule: "own-agent-change",
        reason: `hand ${own.entry.name} over to ${agent}` });
    }
    return continueEntry(own.entry, { rule: "own", fromWorkNodeId: workNodeId, reason: `this work ran in ${own.entry.name}` });
  };

  // Work nodes answering from ENTRY: a node belongs to its newest Run's conversation.
  const ownersOf = (entry) => {
    const owners = new Set();
    for (const id of runsByNode.keys()) {
      if (conversationOf(id)?.entry === entry) owners.add(id);
    }
    return owners;
  };

  // Re-running a block must not stack a second attempt on the first: the new
  // attempt starts again from the document and its upstream state.  A
  // conversation only this block answers from keeps its name under a new
  // generation; one shared with other work stays intact and the re-run
  // branches from upstream instead.  A block that is still running queues.
  const rerunRoute = () => {
    const entry = own.entry;
    if (!sameAgent(entry)) return ownRoute();
    if (entry.openRun) {
      return continueEntry(entry, { rule: "rerun-queued", fromWorkNodeId: workNodeId,
        reason: `${entry.name} is still running; the re-run waits for it` });
    }
    const upstream = lineageEntry && sameAgent(lineageEntry) ? lineageEntry : null;
    const exclusive = [...ownersOf(entry)].every((id) => id === workNodeId);
    if (exclusive && entry.state !== "archived") {
      return decision({ action: "rebind", name: entry.name, parentName: upstream ? upstream.name : "",
        rule: "rerun", fromWorkNodeId: upstream ? lineage.node : "", autoContext: lineageContext,
        reason: upstream
          ? `re-run restarts ${entry.name} from “${titleOf(lineage.node)}”`
          : `re-run restarts ${entry.name} from the document` });
    }
    if (upstream) {
      return fork(upstream, uniqueName(`${upstream.name}/${slug}`, taken), { rule: "rerun-branch",
        fromWorkNodeId: lineage.node, autoContext: lineageContext,
        reason: `${entry.name} is shared with other work; the re-run branches from “${titleOf(lineage.node)}”` });
    }
    return create(slug, { rule: "rerun-new", autoContext: lineageContext,
      reason: `${entry.name} is shared with other work; the re-run starts a new conversation` });
  };

  if (lineageEntry) {
    // A straight chain continues the parent's conversation while the parent is
    // its head.  An open Run still selects this route so the worker queues
    // behind it instead of silently creating or resuming a second conversation.
    if (lineageHead) {
      return continueEntry(lineageEntry, { rule: "lineage-continue", fromWorkNodeId: lineage.node,
        reason: `continues ${lineageEntry.name} from “${titleOf(lineage.node)}”` });
    }
    if (ownInLineage) return rerunRoute();
    // The parent's conversation moved on (a sibling continued it), or this
    // cell's own conversation is outside the lineage: branch from the parent.
    return fork(lineageEntry, uniqueName(`${lineageEntry.name}/${slug}`, taken), { rule: "lineage-branch",
      fromWorkNodeId: lineage.node, autoContext: lineageContext,
      reason: `branches from ${lineageEntry.name} at “${titleOf(lineage.node)}”` });
  }
  if (own?.entry) return rerunRoute();
  if (own?.legacySessionId) {
    return decision({ action: "adopt", name: uniqueName(slug, taken), legacySessionId: own.legacySessionId,
      rule: "own", fromWorkNodeId: workNodeId, reason: "naming this work's earlier session" });
  }
  if (lineage.kind === "ancestor") {
    return create(slug, { rule: "lineage-branch", fromWorkNodeId: lineage.node, autoContext: lineageContext,
      reason: `new session with “${titleOf(lineage.node)}” as context` });
  }
  if (lineage.kind === "merge") {
    return create(slug, { rule: "lineage-merge", autoContext: lineageContext, reason: "joins several lineage parents" });
  }
  if (lineage.climbed) {
    return create(slug, { rule: "lineage-new", autoContext: lineageContext,
      reason: "new session with its upstream blocks as context" });
  }
  return create(slug, { rule: "root", reason: "new line of work" });
}
