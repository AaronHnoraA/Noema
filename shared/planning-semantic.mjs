import {
  patchPlanningNodeRaw,
  scanPlanningNodes,
  serializeInlineAttrs,
} from "./planning-dsl.mjs";
import {
  TODO_KEY_ALIASES,
  applyRepeater,
  formatDateValue,
  normalizeDateValue,
  normalizeTodoStatus,
  parseRepeater,
  todoArgKeyForCanonical,
} from "./planning-values.mjs";

export const CANON_PATCH_KEYS = ["id", "ddl", "sche", "end", "date", "prio", "repeat", "warn", "after", "blocks", "project", "area", "phase", "goal", "effort", "progress", "owner", "tags", "context", "done", "log"];
export const LEGACY_PATCH_TO_CANON = { priority: "prio", due: "ddl", deadline: "ddl", scheduled: "sche", start: "sche", finish: "end", pct: "progress", proj: "project", rep: "repeat", every: "repeat", lead: "warn", dep: "after", ctx: "context" };
export const CREATE_TODO_KEYS = ["ddl", "sche", "end", "prio", "repeat", "warn", "after", "blocks", "project", "area", "phase", "goal", "effort", "progress", "owner", "tags", "context"];

function bodyHasOwn(body, key) {
  return Object.prototype.hasOwnProperty.call(body || {}, key);
}

export function normalizeCanonPatchValue(key, value) {
  if (value === null || value === undefined || value === false) return "";
  const raw = String(value).trim();
  if (!raw) return "";
  if (key === "prio") {
    const p = raw.toUpperCase();
    return /^[A-Z]$/.test(p) ? p : "";
  }
  if (key === "ddl" || key === "sche" || key === "end" || key === "date" || key === "done") return normalizeDateValue(raw) || raw;
  if (key === "progress") return String(Math.max(0, Math.min(100, Number(raw) || 0)));
  if (key === "repeat") return parseRepeater(raw) ? raw : "";
  return raw;
}

function replaceTodoArgsInSource(source, argsRaw, nextArgsRaw) {
  const text = String(source || "");
  const argsText = String(argsRaw || "");
  const nextText = String(nextArgsRaw || "");
  if (argsText) {
    const at = text.lastIndexOf(argsText);
    if (at >= 0) {
      const prefix = text.slice(0, at).trimEnd();
      return nextText ? `${prefix}${text.slice(prefix.length, at)}${nextText}${text.slice(at + argsText.length)}` : `${prefix}${text.slice(at + argsText.length)}`;
    }
  }
  return nextText ? `${text.trimEnd()}${text.endsWith(" ") || text.endsWith("\t") ? "" : " "}${nextText}` : text;
}

// Writes canonical keys while retaining an alias already present in source.
export function patchTodoSourceCanonical(source, canonPatch = {}) {
  const text = String(source || "");
  const node = scanPlanningNodes(text, { kind: "todo" })[0];
  if (!node || node.span.from !== 0) return text;
  const args = { ...(node.attrs || {}) };
  for (const [canonKey, rawValue] of Object.entries(canonPatch)) {
    const value = normalizeCanonPatchValue(canonKey, rawValue);
    if (value) {
      const argKey = todoArgKeyForCanonical(canonKey, node.attrs || {});
      args[argKey] = value;
    } else {
      for (const alias of TODO_KEY_ALIASES[canonKey] || [canonKey]) delete args[alias];
    }
  }
  return node.shape === "block"
    ? patchPlanningNodeRaw(node, { attrs: args })
    : replaceTodoArgsInSource(text, node.attrsRaw || "", serializeInlineAttrs(args));
}

function appendDepRef(existingAfter, ref) {
  const parts = String(existingAfter || "")
    .split("&")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.includes(ref)) parts.push(ref);
  return parts.join(" & ");
}

export function planningNodeArgs(source) {
  const node = scanPlanningNodes(source, { kind: "todo" })[0];
  return node && node.span.from === 0 ? node.attrs || {} : {};
}

function argValueForCanonical(args, canonKey) {
  for (const alias of TODO_KEY_ALIASES[canonKey] || [canonKey]) {
    if (args && Object.prototype.hasOwnProperty.call(args, alias) && args[alias]) return args[alias];
  }
  return "";
}

export function nextTodoSourceForPatch(oldSource, body = {}, nowMs = Date.now()) {
  const op = body.op === "complete" ? "complete" : "patch";
  const canonPatch = {};
  for (const key of CANON_PATCH_KEYS) {
    if (bodyHasOwn(body, key)) canonPatch[key] = body[key];
  }
  for (const [legacy, canon] of Object.entries(LEGACY_PATCH_TO_CANON)) {
    if (bodyHasOwn(body, legacy) && !bodyHasOwn(canonPatch, canon)) canonPatch[canon] = body[legacy];
  }
  const args0 = planningNodeArgs(oldSource);
  if (bodyHasOwn(body, "afterAdd")) {
    canonPatch.after = appendDepRef(argValueForCanonical(args0, "after"), String(body.afterAdd));
  }

  let statusPatch = "";
  if (op === "complete") {
    const repeater = parseRepeater(argValueForCanonical(args0, "repeat"));
    const doneStr = formatDateValue(nowMs, false);
    if (repeater) {
      const ddlVal = argValueForCanonical(args0, "ddl");
      const scheVal = argValueForCanonical(args0, "sche");
      if (ddlVal) canonPatch.ddl = applyRepeater(ddlVal, repeater, nowMs);
      if (scheVal) canonPatch.sche = applyRepeater(scheVal, repeater, nowMs);
      canonPatch.done = doneStr;
      const logParts = String(argValueForCanonical(args0, "log")).split("&").map((part) => part.trim()).filter(Boolean);
      logParts.push(doneStr);
      while (logParts.length > 30) logParts.shift();
      canonPatch.log = logParts.join(" & ");
      statusPatch = "todo";
    } else {
      canonPatch.done = doneStr;
      statusPatch = "done";
    }
  } else if (bodyHasOwn(body, "status")) {
    statusPatch = normalizeTodoStatus(body.status);
  }

  let next = String(oldSource || "");
  if (statusPatch) {
    const command = next.match(/^@@(todo|itodo)(?:\([^\)\n]*\))?[ \t]+/i)?.[1] || "todo";
    const prefix = statusPatch === "todo" ? `@@${command.toLowerCase()} ` : `@@${command.toLowerCase()}(${statusPatch}) `;
    next = next.replace(/^@@(?:todo|itodo)(?:\([^\)\n]*\))?[ \t]+/i, prefix);
  }
  if (Object.keys(canonPatch).length > 0) next = patchTodoSourceCanonical(next, canonPatch);
  return next;
}

export function escapePlanningTitle(text) {
  return String(text || "").replace(/([\]\\])/g, "\\$1");
}

export function clockSourceForTodo(todo, attrs = {}) {
  const title = escapePlanningTitle(typeof todo === "string" ? todo : todo?.title || "");
  const from = String(attrs.from || "").trim();
  const task = String(attrs.task || "").trim();
  return `@@clock [${title}]{from: ${from}, task: ${task}}`;
}

// Test/fixture mirror of the semantic mutation payload accepted by Go. The
// desktop runtime submits this payload instead of a pre-rendered replacement.
export function applyPlanningSemanticMutation(source, mutation = {}) {
  const type = String(mutation.type || "").toLowerCase();
  const wanted = type === "patch-todo" || type === "insert-clock" ? "todo" : "";
  const node = scanPlanningNodes(String(source || ""), wanted ? { kind: wanted } : {})[0];
  if (!node || node.span.from !== 0) return String(source || "");
  if (type === "patch-todo") {
    const semantic = mutation.todo || {};
    const body = { ...(semantic.attrs || {}) };
    if (semantic.op) body.op = semantic.op;
    if (Object.prototype.hasOwnProperty.call(semantic, "status")) body.status = semantic.status;
    if (Object.prototype.hasOwnProperty.call(semantic, "afterAdd")) body.afterAdd = semantic.afterAdd;
    return nextTodoSourceForPatch(node.raw, body, Number(semantic.nowMs || Date.now()));
  }
  if (type === "patch-node") return patchPlanningNodeRaw(node, { attrs: mutation.attrs || {} });
  if (type === "insert-clock") return clockSourceForTodo(node, mutation.attrs || {});
  throw new Error(`unsupported semantic planning mutation ${JSON.stringify(type)}`);
}
