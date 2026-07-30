// Value-grammar layer for the planning DSL: date/duration parsing, repeaters,
// lead times, dependency references, canonical arg-key aliasing, and status
// normalization. Kept separate from shared/planning-dsl.mjs (which only
// knows the `@@kind(status) [title]{attrs}` *structure*) so both the server
// (server/lib/runtime.mjs) and the browser editor (src/planning-values.ts
// facade) can share one parser for validation, not just structure. See
// docs/agenda.md for the full grammar reference.

export const TODO_STATUSES = new Set(["todo", "doing", "done", "blocked", "cancelled"]);

// Canonical keys whose values are dates (as opposed to plain text/numbers).
// `from`/`to` are the @@clock span keys — they take the same date(+time)
// grammar as everything else here.
export const DATE_KEYS = new Set(["ddl", "due", "deadline", "sche", "scheduled", "start", "done", "date", "when", "from", "to"]);

// Canonical @@todo/@@project/@@milestone arg keys and their read aliases.
// Reads normalize every alias to the canonical key; writes reuse whichever
// alias a line already has and only introduce the canonical spelling for
// brand-new args, so existing notes (e.g. `{ddl: ...}`) never get silently
// rewritten.
export const TODO_KEY_ALIASES = {
  id: ["id"],
  ddl: ["ddl", "due", "deadline"],
  sche: ["sche", "scheduled", "start"],
  end: ["end", "finish"],
  prio: ["prio", "priority"],
  repeat: ["repeat", "rep", "every"],
  warn: ["warn", "lead"],
  after: ["after", "dep"],
  blocks: ["blocks"],
  project: ["project", "proj"],
  area: ["area"],
  phase: ["phase"],
  goal: ["goal"],
  effort: ["effort"],
  progress: ["progress", "pct"],
  owner: ["owner"],
  date: ["date", "when"],
  tags: ["tags"],
  context: ["context", "ctx"],
  done: ["done"],
  log: ["log"],
};

export const TODO_CANON_KEYS = Object.keys(TODO_KEY_ALIASES);

export function canonicalTodoArgs(args) {
  const out = {};
  if (!args || typeof args !== "object") return out;
  for (const canon of TODO_CANON_KEYS) {
    for (const alias of TODO_KEY_ALIASES[canon]) {
      if (Object.prototype.hasOwnProperty.call(args, alias) && args[alias]) {
        if (canon === "prio") out[canon] = String(args[alias]).toUpperCase();
        else if (canon === "progress") out[canon] = String(Math.max(0, Math.min(100, Number(args[alias]) || 0)));
        else out[canon] = args[alias];
        break;
      }
    }
  }
  return out;
}

// Which arg key a patch should write for `canonKey`: the alias already
// present on the line, or the canonical spelling if the arg is new.
export function todoArgKeyForCanonical(canonKey, existingArgs) {
  const aliases = TODO_KEY_ALIASES[canonKey] || [canonKey];
  for (const alias of aliases) {
    if (existingArgs && Object.prototype.hasOwnProperty.call(existingArgs, alias)) return alias;
  }
  return aliases[0];
}

export function midnightMs(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function pad2(n) { return String(n).padStart(2, "0"); }

export function parseDateValue(raw) {
  const t = String(raw ?? "").trim();
  if (!t) return null;
  const lower = t.toLowerCase();
  if (lower === "today" || lower === "今天") return { time: midnightMs(new Date()), hasTime: false };
  if (lower === "tomorrow" || lower === "明天") return { time: midnightMs(new Date()) + 86_400_000, hasTime: false };
  if (lower === "yesterday" || lower === "昨天") return { time: midnightMs(new Date()) - 86_400_000, hasTime: false };
  if (lower === "now") return { time: Date.now(), hasTime: true };
  const rel = lower.match(/^([+-])(\d+)\s*(d|day|days|w|week|weeks|m|month|months|y|year|years)$/);
  if (rel) {
    const sign = rel[1] === "-" ? -1 : 1;
    const n = Number(rel[2]) * sign;
    const u = rel[3];
    const base = new Date();
    base.setHours(0, 0, 0, 0);
    if (u.startsWith("d")) base.setDate(base.getDate() + n);
    else if (u.startsWith("w")) base.setDate(base.getDate() + 7 * n);
    else if (u.startsWith("m")) base.setMonth(base.getMonth() + n);
    else if (u.startsWith("y")) base.setFullYear(base.getFullYear() + n);
    return { time: base.getTime(), hasTime: false };
  }
  const cjk = t.replace(/年|月/g, "-").replace(/日|号/g, "");
  const norm = cjk.replace(/[./]/g, "-").trim();
  let m = norm.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?(?:[\sT](\d{1,2}):(\d{2}))?$/);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]) - 1;
    const d = m[3] ? Number(m[3]) : 1;
    const hh = m[4] ? Number(m[4]) : 0;
    const mm = m[5] ? Number(m[5]) : 0;
    const date = new Date(y, mo, d, hh, mm);
    if (Number.isFinite(date.getTime())) return { time: date.getTime(), hasTime: Boolean(m[4]) };
  }
  m = norm.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[\sT](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})$/i);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]) - 1;
    const d = Number(m[3]);
    const hh = Number(m[4]);
    const mm = Number(m[5]);
    // Planning dates are wall-clock calendar values, not instants. Treat an
    // imported ISO timestamp with `Z`/offset as the same local date+time so
    // `2026-07-07T23:30:00Z` stays in the 2026-07-07 agenda bucket instead
    // of drifting to the user's next local day.
    const date = new Date(y, mo, d, hh, mm);
    if (Number.isFinite(date.getTime())) return { time: date.getTime(), hasTime: true };
  }
  m = norm.match(/^(\d{1,2})-(\d{1,2})(?:[\sT](\d{1,2}):(\d{2}))?$/);
  if (m) {
    const mo = Number(m[1]) - 1;
    const d = Number(m[2]);
    const hh = m[3] ? Number(m[3]) : 0;
    const mm = m[4] ? Number(m[4]) : 0;
    if (mo >= 0 && mo < 12 && d >= 1 && d <= 31) {
      const date = new Date(new Date().getFullYear(), mo, d, hh, mm);
      return { time: date.getTime(), hasTime: Boolean(m[3]) };
    }
  }
  const parsed = Date.parse(t);
  if (Number.isFinite(parsed)) return { time: parsed, hasTime: /\d{1,2}:\d{2}/.test(t) };
  return null;
}

export function formatDateValue(time, hasTime) {
  const d = new Date(time);
  const base = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  return hasTime ? `${base} ${pad2(d.getHours())}:${pad2(d.getMinutes())}` : base;
}

export function normalizeDateValue(raw) {
  const parsed = parseDateValue(raw);
  return parsed ? formatDateValue(parsed.time, parsed.hasTime) : null;
}

export function normalizeTodoStatus(raw = "") {
  const value = String(raw || "").trim().toLowerCase();
  if (!value || value === " " || value === "open" || value === "unchecked") return "todo";
  if (value === "~" || value === "-" || value === "wip" || value === "active") return "doing";
  if (value === "x" || value === "checked" || value === "complete") return "done";
  if (value === "!" || value === "block") return "blocked";
  if (value === "cancel" || value === "canceled" || value === "cancelled") return "cancelled";
  return TODO_STATUSES.has(value) ? value : "todo";
}

export function shiftDate(time, n, unit) {
  const d = new Date(time);
  if (unit === "d") d.setDate(d.getDate() + n);
  else if (unit === "w") d.setDate(d.getDate() + 7 * n);
  else if (unit === "m") d.setMonth(d.getMonth() + n);
  else if (unit === "y") d.setFullYear(d.getFullYear() + n);
  return d.getTime();
}

// Repeater grammar: `[+|++|.+]N(d|w|m|y)`; a bare `Nd` behaves like `+Nd`.
export function parseRepeater(raw) {
  const t = String(raw ?? "").trim();
  if (!t) return null;
  const m = t.match(/^(\+\+|\.\+|\+)?(\d+)\s*(d|day|days|w|week|weeks|m|month|months|y|year|years)$/i);
  if (!m) return null;
  const mode = m[1] === "++" ? "++" : m[1] === ".+" ? ".+" : "+";
  const n = Number(m[2]);
  const unitRaw = m[3].toLowerCase();
  const unit = unitRaw.startsWith("d") ? "d" : unitRaw.startsWith("w") ? "w" : unitRaw.startsWith("m") ? "m" : "y";
  return { mode, n, unit };
}

// org semantics: `+` shifts once from the old date (may still land in the
// past); `++` shifts repeatedly until the result is in the future; `.+`
// shifts from the completion moment (`todayMs`), not the old date.
export function applyRepeater(dateStr, repeater, todayMs = Date.now()) {
  const parsed = parseDateValue(dateStr);
  if (!parsed || !repeater) return dateStr;
  const { hasTime } = parsed;
  const todayBase = hasTime ? todayMs : midnightMs(new Date(todayMs));
  let time;
  if (repeater.mode === ".+") {
    time = shiftDate(todayBase, repeater.n, repeater.unit);
  } else if (repeater.mode === "++") {
    let next = shiftDate(parsed.time, repeater.n, repeater.unit);
    let guard = 0;
    while (next <= todayBase && guard < 10000) {
      next = shiftDate(next, repeater.n, repeater.unit);
      guard++;
    }
    time = next;
  } else {
    time = shiftDate(parsed.time, repeater.n, repeater.unit);
  }
  return formatDateValue(time, hasTime);
}

// Deadline warning lead time, e.g. `3d`/`1w`; defaults to org's 14 days.
export function parseLeadTime(raw, fallbackDays = 14) {
  const t = String(raw ?? "").trim();
  if (!t) return fallbackDays;
  const m = t.match(/^(\d+)\s*(d|day|days|w|week|weeks|m|month|months)?$/i);
  if (!m) return fallbackDays;
  const n = Number(m[1]);
  const unit = (m[2] || "d").toLowerCase();
  if (unit.startsWith("w")) return n * 7;
  if (unit.startsWith("m")) return n * 30;
  return n;
}

// `after`/`blocks`/clock-`task` grammar: `dep-ref ( "&" dep-ref )*`, where
// `dep-ref := "#" stable-id | [ "[[" note-title "]]" "::" ] text-part`.
// A `#id` ref resolves directly against a todo's stable `id:` attr (see
// `ensureTodoId` in runtime.mjs) and never needs title/text matching; ids
// are minted on demand (dependency picker, clock-in), so most refs are
// still plain text and go through the fuzzy same-file/cross-file matcher.
export function parseDepRefs(raw) {
  const t = String(raw ?? "").trim();
  if (!t) return [];
  return t
    .split("&")
    .map((part) => {
      const piece = part.trim();
      const idMatch = piece.match(/^#([A-Za-z0-9]+)$/);
      if (idMatch) return { id: idMatch[1], noteTitle: null, text: "", raw: piece };
      const m = piece.match(/^\[\[([^\]]+)\]\]::(.*)$/);
      if (m) return { id: null, noteTitle: m[1].trim(), text: m[2].trim(), raw: piece };
      return { id: null, noteTitle: null, text: piece, raw: piece };
    })
    .filter((ref) => ref.id || ref.text);
}

// Duration grammar for `effort`/clock spans: `2h`, `90m`, `1d` (an 8-hour
// workday), or `H:MM`. Returns total minutes, or null if unparseable.
export function parseDuration(raw) {
  const t = String(raw ?? "").trim();
  if (!t) return null;
  const hm = t.match(/^(\d+):([0-5]\d)$/);
  if (hm) return Number(hm[1]) * 60 + Number(hm[2]);
  const m = t.match(/^(\d+(?:\.\d+)?)\s*(d|day|days|h|hour|hours|m|min|mins|minute|minutes)?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] || "h").toLowerCase();
  if (unit.startsWith("d")) return Math.round(n * 8 * 60);
  if (unit.startsWith("h")) return Math.round(n * 60);
  return Math.round(n);
}

// Inverse of parseDuration for display: total minutes -> `H:MM`.
export function formatDuration(totalMinutes) {
  const mins = Math.max(0, Math.round(Number(totalMinutes) || 0));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}:${pad2(m)}`;
}
