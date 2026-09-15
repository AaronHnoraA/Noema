// D-031 deterministic session naming and DAG-derived defaults.
//
// Every agent conversation a user can reach has a project-scoped name.  A work
// block that says nothing inherits one from its lineage: a straight chain
// keeps talking in one conversation, a branch gets its own reconstructed
// child, and `depends' never carries conversation.  This module is pure: it
// decides from the document, prior Runs and the name registry, and never
// calls a model.

import { researchDependencies, researchError, researchWorkNodes } from "./research-notebook.mjs";

export const SESSION_KEYWORDS = Object.freeze(["continue", "fork", "fresh"]);
export const PI_SESSION_NAME = "pi";
const NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}._/@-]*$/u;

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function nameError(message) {
  return researchError(message, 422, "ERR_RESEARCH_SESSION_NAME");
}

/** Throw unless NAME follows the grammar shared with Go and Emacs. */
export function validateSessionName(name, { allowPi = false } = {}) {
  const value = text(name);
  if (!value) throw nameError("session name is required");
  if ([...value].length > 80) throw nameError(`session name ${value} is longer than 80 characters`);
  if (SESSION_KEYWORDS.includes(value)) throw nameError(`${value} is a reserved @@session keyword, not a name`);
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
  return slug && !SESSION_KEYWORDS.includes(slug) && slug !== PI_SESSION_NAME ? slug : "work";
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
  notebook = null, workNodeId = "", title = "", agent, directive = { kind: "none" },
  requestedName = "", runs = [], names = [],
}) {
  const { byName, bySession, taken } = registry(names);
  const nodes = notebook ? researchWorkNodes(notebook) : [];
  const edges = notebook ? researchDependencies(notebook) : [];
  const titleOf = (id) => text(nodes.find((node) => node.id === id)?.title) || (id === workNodeId ? text(title) : "");
  const slug = sessionNameSlug(titleOf(workNodeId) || title);
  const lineageParents = (id) => edges.filter((edge) => edge.to === id && edge.type === "lineage").map((edge) => edge.from);

  // Newest Run of a WorkNode that has a reachable conversation.
  const conversationOf = (id) => {
    for (const run of Array.isArray(runs) ? runs : []) {
      if (text(run?.workNodeId ?? run?.work_node_id) !== id) continue;
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
    while (current) {
      const parents = lineageParents(current).filter((id) => !seen.has(id));
      if (parents.length === 0) return { kind: "root" };
      if (parents.length > 1) return { kind: "merge", at: current };
      const [parent] = parents;
      seen.add(parent);
      const found = conversationOf(parent);
      if (found) return { kind: "ancestor", node: parent, ...found };
      current = parent;
    }
    return { kind: "root" };
  })();
  const base = own?.entry || (lineage.kind === "ancestor" ? lineage.entry : null);
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
        fromWorkNodeId: own ? workNodeId : lineage.node, reason: `continue ${base.name}` });
    }
    if (own?.legacySessionId) {
      return decision({ action: "adopt", name: uniqueName(slug, taken), legacySessionId: own.legacySessionId,
        origin: "user", rule: "directive-continue", reason: "continue the earlier unnamed session" });
    }
    return create(slug, { origin: "user", rule: "directive-continue", reason: "nothing to continue; started a new session" });
  default:
    break;
  }

  if (own?.entry) {
    if (own.entry.agent && own.entry.agent !== agent) {
      return fork(own.entry, uniqueName(`${own.entry.name}@${agent}`, taken), { rule: "own-agent-change",
        reason: `hand ${own.entry.name} over to ${agent}` });
    }
    return continueEntry(own.entry, { rule: "own", fromWorkNodeId: workNodeId, reason: `this work ran in ${own.entry.name}` });
  }
  if (own?.legacySessionId) {
    return decision({ action: "adopt", name: uniqueName(slug, taken), legacySessionId: own.legacySessionId,
      rule: "own", fromWorkNodeId: workNodeId, reason: "naming this work's earlier session" });
  }
  if (lineage.kind === "ancestor" && lineage.entry) {
    const entry = lineage.entry;
    const head = text(entry.lastRun?.workNodeId);
    if ((!entry.agent || entry.agent === agent) && head === lineage.node && !entry.openRun) {
      return continueEntry(entry, { rule: "lineage-continue", fromWorkNodeId: lineage.node,
        reason: `continues ${entry.name} from “${titleOf(lineage.node)}”` });
    }
    return fork(entry, uniqueName(`${entry.name}/${slug}`, taken), { rule: "lineage-branch", fromWorkNodeId: lineage.node,
      autoContext: ["lineage"], reason: `branches from ${entry.name} at “${titleOf(lineage.node)}”` });
  }
  if (lineage.kind === "ancestor") {
    return create(slug, { rule: "lineage-branch", fromWorkNodeId: lineage.node, autoContext: ["lineage"],
      reason: `new session with “${titleOf(lineage.node)}” as context` });
  }
  if (lineage.kind === "merge") {
    return create(slug, { rule: "lineage-merge", autoContext: ["lineage"], reason: "joins several lineage parents" });
  }
  return create(slug, { rule: "root", reason: "new line of work" });
}
