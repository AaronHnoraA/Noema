/**
 * Inline @@command widgets — handles @@todo(status) [text]{args},
 * @@itodo(status) [text]{args},
 * @@tag[name], and @@comment(true?) [text]{args}.
 *
 * Uses a ViewPlugin (viewport-scoped) since these are inline decorations
 * (no block:true needed).  When the cursor is inside a command span the
 * raw source is shown; otherwise it is replaced with a rendered chip.
 */

import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { MeasuredWidget } from "./measured-widget.ts";
import { findInlineCommandClose, parseCommandArgs, scanInlineCommands, type InlineCommand } from "../../../../command-syntax.ts";
import { renderMarkdownHTML } from "../../../../render-html.ts";
import type { Range } from "@codemirror/state";
import { blockMathRangesOverlapping, mergeOverlappingRanges, positionInsideAnyRange } from "../../../math-ranges.ts";
import { scanCodeRanges } from "../../../code-ranges.ts";
import { scanInlineMathRanges } from "../../../../inline-math.ts";
import {
  DATE_KEYS,
  DATE_KEY_LABELS,
  formatDateValue,
  parseDateValue,
  relativeDateClass,
  relativeDateLabel,
} from "../../../../date-syntax.ts";
import { hasViewportDecorationRefresh } from "../../../viewport-refresh.ts";
import { latexMark } from "../../../../../shared/latex-marks.mjs";

declare global {
  interface Window {
    AaronnoteBibliography?: {
      citationLabel?: (from: number, to: number) => { label: string; title?: string; error?: boolean } | null;
      version?: () => number;
      mapChanges?: (changes: readonly {
        from: number;
        to: number;
        insertedLength: number;
        insertedText?: string;
        deletedText?: string;
      }[]) => void;
      openCitation?: (from: number, to: number, rect: DOMRect, jump: boolean) => void;
      contextMenu?: (from: number, to: number, x: number, y: number) => void;
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type TodoCommand = InlineCommand & {
  blockBodyFrom?: number;
  blockTo?: number;
};

type PlanningUiCommand = TodoCommand;

/**
 * Render a @@todo body as inline HTML so embedded markdown — notably inline math
 * `\(…\)` — renders inside the chip. The body sits in a replaced widget, so the
 * usual live-preview math decoration cannot reach it; we render it here instead,
 * via the same shared renderer the table cells use, and unwrap the `<p>`.
 */
export function inlineTodoBodyHTML(markdown: string): string {
  const html = renderMarkdownHTML(markdown);
  const match = /^<p>([\s\S]*)<\/p>\n?$/.exec(html.trim());
  return match ? match[1] : html;
}

const STATUS_LABELS: Record<string, string> = {
  todo: "TODO",
  doing: "DOING",
  done: "DONE",
  blocked: "BLOCKED",
  cancelled: "CANCELLED",
  "": "TODO",
};

const STATUS_ICONS: Record<string, string> = {
  todo: "□",
  doing: "▶",
  done: "✓",
  blocked: "✕",
  cancelled: "⊘",
};

const TODO_SUMMARY_KEYS = new Set(["project", "proj", "phase", "area", "owner", "context", "ctx"]);
const TODO_TIME_KEYS = new Set(["effort", "progress", "repeat", "rep", "every"]);
const TASK_COMMAND_NAMES = new Set(["todo", "itodo"]);
const PLANNING_BLOCK_NAMES = new Set(["project", "milestone", "clock"]);
const PLANNING_KIND_LABELS: Record<string, string> = {
  todo: "TODO",
  project: "PROJECT",
  milestone: "MILESTONE",
  clock: "CLOCK",
};

function statusLabel(sw: string): string {
  return STATUS_LABELS[sw.toLowerCase()] ?? sw.toUpperCase();
}

function statusIcon(sw: string): string {
  return STATUS_ICONS[sw.toLowerCase()] ?? "•";
}

function cleanTag(value: string): string {
  return value.trim().replace(/^#/, "");
}

function todoCommandBlocks(text: string): TodoCommand[] {
  const out: TodoCommand[] = [];
  const re = /@@(todo|itodo)(?:\(([^)\n]*)\))?[ \t]+\[/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const name = match[1].toLowerCase();
    const openBracket = re.lastIndex - 1;
    const closeBracket = findInlineCommandClose(text, openBracket, "]");
    if (closeBracket < 0) continue;
    let pos = closeBracket + 1;
    while (text[pos] === " " || text[pos] === "\t") pos++;
    if (text[pos] !== "{") continue;
    const sameLineEnd = text.indexOf("\n", pos + 1);
    const sameLineClose = findInlineCommandClose(text.slice(0, sameLineEnd < 0 ? text.length : sameLineEnd), pos, "}");
    if (sameLineClose >= 0) {
      re.lastIndex = sameLineClose + 1;
      continue;
    }
    const tail = text.slice(pos + 1);
    const closeMatch = tail.match(/\n[ \t]*}/);
    if (!closeMatch || closeMatch.index === undefined) continue;
    const closeBrace = pos + 1 + closeMatch.index + closeMatch[0].lastIndexOf("}");
    const blockTo = closeBrace + 1;
    const sourceTo = pos + 1;
    out.push({
      name,
      switchValue: match[2]?.trim() ?? "",
      context: text.slice(openBracket + 1, closeBracket),
      argsRaw: text.slice(pos, blockTo),
      args: parseCommandArgs(text.slice(pos, blockTo)),
      fullFrom: match.index,
      fullTo: sourceTo,
      blockBodyFrom: sourceTo,
      blockTo,
      contextFrom: openBracket + 1,
      contextTo: closeBracket,
    });
    re.lastIndex = blockTo;
  }
  return out;
}

function planningCommandBlocks(text: string): PlanningUiCommand[] {
  const out: PlanningUiCommand[] = [];
  const re = /@@(project|milestone|clock)(?:\(([^)\n]*)\))?[ \t]+/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const name = match[1].toLowerCase();
    const titleFrom = re.lastIndex;
    const lineEnd = text.indexOf("\n", titleFrom);
    const headerEnd = lineEnd < 0 ? text.length : lineEnd;
    const openBrace = text.indexOf("{", titleFrom);
    if (openBrace < 0 || openBrace > headerEnd) continue;

    const title = text.slice(titleFrom, openBrace).trim();
    if (!title) continue;

    const sameLineClose = findInlineCommandClose(text.slice(0, headerEnd), openBrace, "}");
    if (sameLineClose >= 0) {
      out.push({
        name,
        switchValue: match[2]?.trim() ?? "",
        context: title,
        argsRaw: text.slice(openBrace, sameLineClose + 1),
        args: parseCommandArgs(text.slice(openBrace, sameLineClose + 1)),
        fullFrom: match.index,
        fullTo: sameLineClose + 1,
        contextFrom: titleFrom,
        contextTo: openBrace,
      });
      re.lastIndex = sameLineClose + 1;
      continue;
    }

    const tail = text.slice(openBrace + 1);
    const closeMatch = tail.match(/\n[ \t]*}/);
    if (!closeMatch || closeMatch.index === undefined) continue;
    const closeBrace = openBrace + 1 + closeMatch.index + closeMatch[0].lastIndexOf("}");
    const blockTo = closeBrace + 1;
    const sourceTo = openBrace + 1;
    out.push({
      name,
      switchValue: match[2]?.trim() ?? "",
      context: title,
      argsRaw: text.slice(openBrace, blockTo),
      args: parseCommandArgs(text.slice(openBrace, blockTo)),
      fullFrom: match.index,
      fullTo: sourceTo,
      blockBodyFrom: sourceTo,
      blockTo,
      contextFrom: titleFrom,
      contextTo: openBrace,
    });
    re.lastIndex = blockTo;
  }
  return out;
}

function visibleInlineCommands(text: string): PlanningUiCommand[] {
  const blocks = [...todoCommandBlocks(text), ...planningCommandBlocks(text)];
  const blockSpans = blocks.map((cmd) => ({ from: cmd.fullFrom, to: cmd.blockTo ?? cmd.fullTo }));
  const inline = scanInlineCommands(text).filter((cmd) => {
    if (blockSpans.some((span) => cmd.fullFrom >= span.from && cmd.fullTo <= span.to)) return false;
    if (!TASK_COMMAND_NAMES.has(cmd.name)) return true;
    let pos = cmd.fullTo;
    while (text[pos] === " " || text[pos] === "\t") pos++;
    if (text[pos] !== "{") return true;
    // If this is a multi-line block but `todoCommandBlocks` could not see the
    // closing brace in the current viewport slice, keep the original inline
    // header widget as a fallback. ViewPlugin decorations cannot replace
    // across line breaks, and viewport slices may end before the block closes.
    return true;
  });
  return [...blocks, ...inline].sort((a, b) => a.fullFrom - b.fullFrom || a.fullTo - b.fullTo);
}

function appendTodoPill(meta: HTMLElement, key: string, value: string): void {
  const lowKey = key.toLowerCase();
  const isDateKey = DATE_KEYS.has(lowKey);
  const parsed = isDateKey ? parseDateValue(value) : null;
  if (lowKey === "prio" || lowKey === "priority") {
    const pill = document.createElement("span");
    pill.className = "inline-todo-prio";
    pill.dataset.prio = value.trim().toUpperCase();
    pill.textContent = `#${value.trim().toUpperCase()}`;
    meta.append(pill);
  } else if (lowKey === "after" || lowKey === "dep") {
    const pill = document.createElement("span");
    pill.className = "inline-todo-dep";
    pill.title = value;
    pill.textContent = `after ${value}`;
    meta.append(pill);
  } else if (lowKey === "repeat" || lowKey === "rep" || lowKey === "every") {
    const pill = document.createElement("span");
    pill.className = "inline-todo-repeat";
    pill.textContent = `↻ ${value}`;
    meta.append(pill);
  } else if (isDateKey && parsed) {
    const canonical = formatDateValue(parsed.time, parsed.hasTime);
    const pill = document.createElement("span");
    pill.className = "inline-todo-date";
    pill.dataset.when = relativeDateClass(parsed.time);
    pill.dataset.key = lowKey;
    const k = document.createElement("span");
    k.className = "inline-todo-date-key";
    k.textContent = DATE_KEY_LABELS[lowKey] ?? lowKey;
    const v = document.createElement("span");
    v.className = "inline-todo-date-value";
    v.textContent = canonical;
    v.title = canonical === value.trim() ? canonical : `${value.trim()} → ${canonical}`;
    const rel = document.createElement("span");
    rel.className = "inline-todo-date-rel";
    rel.textContent = relativeDateLabel(parsed.time);
    pill.append(k, v, rel);
    meta.append(pill);
  } else if (isDateKey && !parsed) {
    const pill = document.createElement("span");
    pill.className = "inline-todo-date is-invalid";
    pill.dataset.key = lowKey;
    pill.title = `Unparseable date: ${value.trim()}`;
    const k = document.createElement("span");
    k.className = "inline-todo-date-key";
    k.textContent = DATE_KEY_LABELS[lowKey] ?? lowKey;
    const v = document.createElement("span");
    v.className = "inline-todo-date-value";
    v.textContent = value.trim();
    pill.append(k, v);
    meta.append(pill);
  } else {
    const pill = document.createElement("span");
    pill.className = "inline-todo-arg";
    const k = document.createElement("span");
    k.className = "inline-todo-arg-key";
    k.textContent = key;
    const v = document.createElement("span");
    v.className = "inline-todo-arg-value";
    v.textContent = value;
    pill.append(k, v);
    meta.append(pill);
  }
}

function appendPlanningMeta(meta: HTMLElement, args: Record<string, string>): void {
  for (const [key, value] of Object.entries(args)) {
    if (!key || !value) continue;
    appendTodoPill(meta, key, value);
  }
}

// ---------------------------------------------------------------------------
// Widget
// ---------------------------------------------------------------------------

class TodoWidget extends MeasuredWidget {
  cmd: TodoCommand;

  constructor(cmd: TodoCommand) {
    super();
    this.cmd = cmd;
  }

  protected measureKey(): string { return ""; }
  protected get measuredBlock(): boolean { return false; }

  eq(other: TodoWidget): boolean {
    return (
      this.cmd.switchValue === other.cmd.switchValue &&
      this.cmd.context === other.cmd.context &&
      this.cmd.argsRaw === other.cmd.argsRaw &&
      this.cmd.fullFrom === other.cmd.fullFrom &&
      this.cmd.fullTo === other.cmd.fullTo
    );
  }

  toDOM(): HTMLElement {
    const { cmd } = this;
    const status = cmd.switchValue.toLowerCase() || "todo";

    const wrap = document.createElement("span");
    wrap.className = "inline-todo-widget inline-command-token";
    wrap.dataset.command = cmd.name;
    wrap.dataset.status = status;
    wrap.dataset.shape = cmd.argsRaw.includes("\n") ? "block" : "inline";
    wrap.dataset.cmSourceFrom = String(cmd.fullFrom);
    wrap.dataset.cmSourceTo = String(cmd.fullTo);
    wrap.dataset.cmOpenSource = "true";
    wrap.dataset.planningKind = cmd.name;
    wrap.dataset.planningStatus = status;
    wrap.dataset.planningSourceFrom = String(cmd.fullFrom);
    wrap.dataset.planningSourceTo = String(cmd.blockTo ?? cmd.fullTo);

    const card = document.createElement("span");
    card.className = "inline-todo-card";

    const head = document.createElement("span");
    head.className = "inline-todo-head";

    const kind = document.createElement("span");
    kind.className = "inline-todo-kind";
    kind.textContent = cmd.name === "itodo" ? "ITODO" : "TODO";
    head.append(kind);

    const chip = document.createElement("span");
    chip.className = "inline-todo-chip";
    chip.dataset.status = status;

    const icon = document.createElement("span");
    icon.className = "inline-todo-chip-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = statusIcon(status);
    chip.append(icon);

    const label = document.createElement("span");
    label.className = "inline-todo-chip-label";
    label.textContent = statusLabel(status);
    chip.append(label);

    head.append(chip);

    if (cmd.context.trim()) {
      const text = document.createElement("span");
      text.className = "inline-todo-text";
      const lBracket = document.createElement("span");
      lBracket.className = "inline-todo-bracket";
      lBracket.setAttribute("aria-hidden", "true");
      lBracket.textContent = "[";
      const body = document.createElement("span");
      body.className = "inline-todo-text-body";
      body.innerHTML = inlineTodoBodyHTML(cmd.context.trim());
      const rBracket = document.createElement("span");
      rBracket.className = "inline-todo-bracket";
      rBracket.setAttribute("aria-hidden", "true");
      rBracket.textContent = "]";
      text.append(lBracket, body, rBracket);
      head.append(text);
    }
    card.append(head);

    const metaEntries = Object.entries(cmd.args)
      .filter((entry): entry is [string, string] => Boolean(entry[0] && entry[1]));
    if (metaEntries.length > 0) {
      const meta = document.createElement("span");
      meta.className = "inline-todo-meta";

      const primary = document.createElement("span");
      primary.className = "inline-todo-meta-row inline-todo-meta-primary";
      const secondary = document.createElement("span");
      secondary.className = "inline-todo-meta-row inline-todo-meta-secondary";
      const dependencies = document.createElement("span");
      dependencies.className = "inline-todo-meta-row inline-todo-meta-deps";

      for (const [key, value] of metaEntries) {
        const lowKey = key.toLowerCase();
        const target = lowKey === "after" || lowKey === "dep"
          ? dependencies
          : DATE_KEYS.has(lowKey) || lowKey === "prio" || lowKey === "priority" || TODO_TIME_KEYS.has(lowKey)
            ? primary
            : TODO_SUMMARY_KEYS.has(lowKey)
              ? secondary
              : secondary;
        appendTodoPill(target, key, value);
      }
      if (primary.childNodes.length > 0) meta.append(primary);
      if (secondary.childNodes.length > 0) meta.append(secondary);
      if (dependencies.childNodes.length > 0) meta.append(dependencies);
      card.append(meta);
    }

    wrap.append(card);

    const rail = document.createElement("span");
    rail.className = "inline-todo-rail";
    rail.setAttribute("aria-hidden", "true");
    wrap.append(rail);

    return wrap;
  }

  ignoreEvent(): boolean { return false; }
}

class PlanningBlockWidget extends MeasuredWidget {
  cmd: PlanningUiCommand;

  constructor(cmd: PlanningUiCommand) {
    super();
    this.cmd = cmd;
  }

  protected measureKey(): string { return ""; }
  protected get measuredBlock(): boolean { return false; }

  eq(other: PlanningBlockWidget): boolean {
    return (
      this.cmd.name === other.cmd.name &&
      this.cmd.switchValue === other.cmd.switchValue &&
      this.cmd.context === other.cmd.context &&
      this.cmd.argsRaw === other.cmd.argsRaw &&
      this.cmd.fullFrom === other.cmd.fullFrom &&
      this.cmd.fullTo === other.cmd.fullTo
    );
  }

  toDOM(): HTMLElement {
    const { cmd } = this;
    const kind = cmd.name.toLowerCase();

    const wrap = document.createElement("span");
    wrap.className = "inline-planning-widget inline-command-token";
    wrap.dataset.kind = kind;
    const status = cmd.switchValue.trim().toLowerCase() || (kind === "todo" ? "todo" : "");
    if (status) wrap.dataset.status = status;
    wrap.dataset.cmSourceFrom = String(cmd.fullFrom);
    wrap.dataset.cmSourceTo = String(cmd.fullTo);
    wrap.dataset.cmOpenSource = "true";
    wrap.dataset.planningKind = kind;
    if (status) wrap.dataset.planningStatus = status;
    wrap.dataset.planningSourceFrom = String(cmd.fullFrom);
    wrap.dataset.planningSourceTo = String(cmd.blockTo ?? cmd.fullTo);

    const head = document.createElement("span");
    head.className = "inline-planning-head";

    const badge = document.createElement("span");
    badge.className = "inline-planning-badge";
    badge.textContent = PLANNING_KIND_LABELS[kind] ?? kind.toUpperCase();
    head.append(badge);

    if (status) {
      const state = document.createElement("span");
      state.className = "inline-planning-state";
      state.textContent = statusLabel(status);
      head.append(state);
    }

    const title = document.createElement("span");
    title.className = "inline-planning-title";
    title.innerHTML = inlineTodoBodyHTML(cmd.context.trim());
    head.append(title);
    wrap.append(head);

    const metaEntries = Object.entries(cmd.args).filter(([, value]) => Boolean(value));
    if (metaEntries.length > 0) {
      const meta = document.createElement("span");
      meta.className = "inline-planning-meta inline-todo-meta-row";
      appendPlanningMeta(meta, cmd.args);
      wrap.append(meta);
    }

    return wrap;
  }

  ignoreEvent(): boolean { return false; }
}

class TagWidget extends MeasuredWidget {
  tag: string;
  from: number;
  to: number;

  constructor(tag: string, from: number, to: number) {
    super();
    this.tag = tag;
    this.from = from;
    this.to = to;
  }

  protected measureKey(): string { return ""; }
  protected get measuredBlock(): boolean { return false; }

  eq(other: TagWidget): boolean {
    return this.tag === other.tag && this.from === other.from && this.to === other.to;
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "inline-tag-widget inline-command-token";
    wrap.dataset.cmSourceFrom = String(this.from);
    wrap.dataset.cmSourceTo = String(this.to);
    wrap.dataset.cmOpenSource = "true";
    wrap.title = `@@tag[${this.tag}]`;
    wrap.setAttribute("aria-label", `Inline anchor ${this.tag}`);

    const marker = document.createElement("span");
    marker.className = "inline-tag-anchor";
    marker.setAttribute("aria-hidden", "true");
    marker.textContent = "§";

    const label = document.createElement("span");
    label.className = "inline-tag-label";
    label.textContent = this.tag;

    wrap.append(marker, label);
    return wrap;
  }

  ignoreEvent(): boolean { return false; }
}

class LatexMarkWidget extends MeasuredWidget {
  mark: string;
  from: number;
  to: number;

  constructor(mark: string, from: number, to: number) {
    super();
    this.mark = mark;
    this.from = from;
    this.to = to;
  }

  protected measureKey(): string { return this.mark; }
  protected get measuredBlock(): boolean { return false; }

  eq(other: LatexMarkWidget): boolean {
    return this.mark === other.mark && this.from === other.from && this.to === other.to;
  }

  toDOM(): HTMLElement {
    const marker = document.createElement("span");
    const spec = latexMark(this.mark);
    marker.className = "inline-latex-mark-widget inline-command-token";
    marker.dataset.cmSourceFrom = String(this.from);
    marker.dataset.cmSourceTo = String(this.to);
    marker.dataset.cmOpenSource = "true";
    marker.dataset.mark = this.mark;
    marker.dataset.valid = spec ? "true" : "false";
    marker.title = spec ? `LaTeX mark: ${spec.label} (@@latexmk(${this.mark}))` : `Unknown LaTeX mark: ${this.mark}`;
    marker.setAttribute("aria-label", spec?.label || `Unknown LaTeX mark ${this.mark}`);
    const latex = document.createElement("span");
    latex.className = "inline-latex-mark-logo";
    latex.textContent = "LaTeX";
    const value = document.createElement("span");
    value.className = "inline-latex-mark-symbol";
    value.textContent = spec?.symbol || "?";
    marker.append(latex, value);
    return marker;
  }

  ignoreEvent(): boolean { return false; }
}

function stopWidgetEventPropagation(event: Event): void {
  event.stopPropagation();
}

/**
 * `@@comment [text]{args}` — a private annotation chip. Mirrors the org-env
 * block comment's dimmed collapsible UI (`org-env-comment-*` classes) but as
 * an inline replace widget instead of a block:true one. `@@comment(true)` is
 * the explicit public/display variant: its body stays visible and is prefixed
 * with a prominent `COMMENT:` label. Every other switch value, including an
 * omitted switch, retains the private collapsed behavior.
 */
class InlineCommentWidget extends MeasuredWidget {
  cmd: InlineCommand;

  constructor(cmd: InlineCommand) {
    super();
    this.cmd = cmd;
  }

  protected measureKey(): string { return this.cmd.switchValue.toLowerCase(); }
  protected get measuredBlock(): boolean { return false; }

  eq(other: InlineCommentWidget): boolean {
    return (
      this.cmd.context === other.cmd.context &&
      this.cmd.switchValue === other.cmd.switchValue &&
      this.cmd.fullFrom === other.cmd.fullFrom &&
      this.cmd.fullTo === other.cmd.fullTo
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const { cmd } = this;
    const context = cmd.context.trim();
    const display = cmd.switchValue.trim().toLowerCase() === "true";

    const wrap = document.createElement("span");
    wrap.className = display
      ? "inline-comment-widget inline-comment-display inline-command-token"
      : "inline-comment-widget inline-command-token";
    wrap.dataset.commentOpen = display ? "true" : "false";
    wrap.dataset.cmSourceFrom = String(cmd.fullFrom);
    wrap.dataset.cmSourceTo = String(cmd.fullTo);
    wrap.dataset.cmOpenSource = "true";

    if (display) {
      wrap.setAttribute("role", "note");
      wrap.setAttribute("aria-label", `Comment: ${context}`);
      const label = document.createElement("span");
      label.className = "inline-comment-display-label";
      label.textContent = "COMMENT:";
      const content = document.createElement("span");
      content.className = "inline-comment-display-content";
      content.innerHTML = context ? inlineTodoBodyHTML(context) : "";
      wrap.append(label, content);
      return wrap;
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = "org-env-comment-button";
    button.setAttribute("aria-expanded", "false");

    const label = document.createElement("span");
    label.className = "org-env-comment-label";
    label.textContent = "comment";

    const state = document.createElement("span");
    state.className = "org-env-comment-state";
    state.textContent = "show";
    button.append(label, state);
    button.addEventListener("mousedown", stopWidgetEventPropagation);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const open = content.hidden === true;
      content.hidden = !open;
      wrap.classList.toggle("inline-comment-open", open);
      wrap.dataset.commentOpen = open ? "true" : "false";
      button.setAttribute("aria-expanded", open ? "true" : "false");
      state.textContent = open ? "hide" : "show";
      if (wrap.isConnected) view.requestMeasure();
    });

    const content = document.createElement("span");
    content.className = "org-env-content";
    content.hidden = true;
    content.innerHTML = context ? inlineTodoBodyHTML(context) : "";
    content.addEventListener("mousedown", stopWidgetEventPropagation);

    wrap.append(button, content);
    return wrap;
  }

  ignoreEvent(): boolean { return false; }
}

const REVISION_STYLES = new Set(["indigo", "teal", "red", "green", "yellow"]);

function revisionDecoded(value: string): string {
  return String(value || "").replace(/\\\]/g, "]").replace(/\\\\/g, "\\");
}

/** An unresolved, always-visible review suggestion backed by one source span. */
class RevisionWidget extends MeasuredWidget {
  cmd: InlineCommand;

  constructor(cmd: InlineCommand) {
    super();
    this.cmd = cmd;
  }

  protected measureKey(): string { return this.cmd.switchValue.toLowerCase(); }
  protected get measuredBlock(): boolean { return false; }

  eq(other: RevisionWidget): boolean {
    return this.cmd.context === other.cmd.context
      && this.cmd.argsRaw === other.cmd.argsRaw
      && this.cmd.switchValue === other.cmd.switchValue
      && this.cmd.fullFrom === other.cmd.fullFrom
      && this.cmd.fullTo === other.cmd.fullTo;
  }

  toDOM(view: EditorView): HTMLElement {
    const original = revisionDecoded(this.cmd.context.trim());
    const advice = revisionDecoded(this.cmd.args.advice || "");
    const reason = revisionDecoded(this.cmd.args.reason || "");
    const requestedStyle = this.cmd.switchValue.trim().toLowerCase();
    const style = REVISION_STYLES.has(requestedStyle) ? requestedStyle : "indigo";
    const wrap = document.createElement("span");
    wrap.className = "aaronnote-revision inline-command-token";
    wrap.dataset.revisionStyle = style;
    wrap.dataset.cmSourceFrom = String(this.cmd.fullFrom);
    wrap.dataset.cmSourceTo = String(this.cmd.fullTo);
    wrap.setAttribute("role", "note");
    wrap.setAttribute("aria-label", `Revision: replace ${original} with ${advice || "missing advice"}`);

    const shown = document.createElement("span");
    shown.className = "aaronnote-revision-original";
    shown.innerHTML = inlineTodoBodyHTML(original);
    shown.tabIndex = 0;

    const card = document.createElement("span");
    card.className = "aaronnote-revision-card";
    const label = document.createElement("strong");
    label.textContent = "Suggestion";
    const replacement = document.createElement("span");
    replacement.className = "aaronnote-revision-advice";
    replacement.innerHTML = advice ? inlineTodoBodyHTML(advice) : "Missing advice";
    card.append(label, replacement);
    if (reason) {
      const why = document.createElement("span");
      why.className = "aaronnote-revision-reason";
      why.textContent = reason;
      card.append(why);
    }
    const actions = document.createElement("span");
    actions.className = "aaronnote-revision-actions";
    const action = (text: string, title: string, run: () => void): HTMLButtonElement => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = text;
      button.title = title;
      button.addEventListener("mousedown", (event) => { event.preventDefault(); event.stopPropagation(); });
      button.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); run(); });
      return button;
    };
    actions.append(
      action("Accept", "Replace original text with the suggestion", () => {
        if (!advice) return;
        view.dispatch({
          changes: { from: this.cmd.fullFrom, to: this.cmd.fullTo, insert: advice },
          selection: { anchor: this.cmd.fullFrom + advice.length },
          scrollIntoView: true,
        });
        view.focus();
      }),
      action("Keep", "Keep the original text", () => {
        view.dispatch({
          changes: { from: this.cmd.fullFrom, to: this.cmd.fullTo, insert: original },
          selection: { anchor: this.cmd.fullFrom + original.length },
          scrollIntoView: true,
        });
        view.focus();
      }),
      action("Edit", "Edit the revision source", () => {
        view.dispatch({
          selection: { anchor: this.cmd.fullFrom, head: this.cmd.fullTo },
          scrollIntoView: true,
        });
        view.focus();
      }),
    );
    card.append(actions);
    wrap.append(shown, card);
    return wrap;
  }

  ignoreEvent(): boolean { return true; }
}

class CiteWidget extends MeasuredWidget {
  cmd: InlineCommand;
  bibliographyVersion: number;

  constructor(cmd: InlineCommand) {
    super();
    this.cmd = cmd;
    this.bibliographyVersion = window.AaronnoteBibliography?.version?.() ?? 0;
  }

  protected measureKey(): string { return ""; }
  protected get measuredBlock(): boolean { return false; }

  eq(other: CiteWidget): boolean {
    return this.cmd.context === other.cmd.context
      && this.cmd.switchValue === other.cmd.switchValue
      && this.cmd.argsRaw === other.cmd.argsRaw
      && this.cmd.fullFrom === other.cmd.fullFrom
      && this.cmd.fullTo === other.cmd.fullTo
      && this.bibliographyVersion === other.bibliographyVersion;
  }

  toDOM(): HTMLElement {
    return createInteractiveCiteElement(this.cmd);
  }

  ignoreEvent(): boolean { return false; }
}

/** Build the interactive citation used by both ordinary prose and meta summaries. */
export function createInteractiveCiteElement(cmd: InlineCommand): HTMLElement {
  const cite = window.AaronnoteBibliography?.citationLabel?.(cmd.fullFrom, cmd.fullTo);
  const wrap = document.createElement("span");
  const error = cite?.error === true;
  const label = cite?.label || `[${cmd.context.trim() || "?"}]`;
  const fallbackTitle = `${cmd.switchValue ? `${cmd.switchValue}:` : ""}${cmd.context.trim() || "?"}`;
  const title = cite?.title || (error ? `Unresolved citation: ${fallbackTitle}` : fallbackTitle);
  wrap.className = `inline-cite-widget inline-command-token${error ? " is-error" : ""}`;
  wrap.dataset.cmSourceFrom = String(cmd.fullFrom);
  wrap.dataset.cmSourceTo = String(cmd.fullTo);
  wrap.dataset.cmOpenSource = "true";
  wrap.dataset.citeState = error ? "error" : "resolved";
  wrap.setAttribute("role", "button");
  wrap.tabIndex = 0;
  wrap.setAttribute("aria-invalid", String(error));
  wrap.setAttribute("aria-label", error ? `Citation error: ${title}` : `Citation ${label}. ${title}`);
  wrap.title = title;
  const text = document.createElement("span");
  text.className = "inline-cite-label";
  text.textContent = label;
  wrap.appendChild(text);
  if (error) {
    const mark = document.createElement("span");
    mark.className = "inline-cite-error-mark";
    mark.textContent = "⚠";
    mark.setAttribute("aria-hidden", "true");
    wrap.append(" ", mark);
  }
  wrap.addEventListener("mousedown", (event) => {
    if (event.metaKey || event.ctrlKey) stopWidgetEventPropagation(event);
  });
  wrap.addEventListener("click", (event) => {
    if (!event.metaKey && !event.ctrlKey) return;
    event.preventDefault();
    event.stopPropagation();
    window.AaronnoteBibliography?.openCitation?.(cmd.fullFrom, cmd.fullTo, wrap.getBoundingClientRect(), true);
  });
  wrap.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") return;
    event.preventDefault();
    event.stopPropagation();
    window.AaronnoteBibliography?.openCitation?.(cmd.fullFrom, cmd.fullTo, wrap.getBoundingClientRect(), true);
  });
  wrap.addEventListener("contextmenu", (event) => {
    const handler = window.AaronnoteBibliography?.contextMenu;
    if (!handler) return;
    event.preventDefault();
    event.stopPropagation();
    handler(cmd.fullFrom, cmd.fullTo, event.clientX, event.clientY);
  });
  return wrap;
}

function visualLineTextRight(line: HTMLElement, anchorRect: DOMRect, ignored: HTMLElement): number {
  const doc = line.ownerDocument;
  const win = doc.defaultView;
  if (!win) return anchorRect.right;
  const filter = {
    acceptNode(node: Node): number {
      if (!node.textContent?.trim()) return win.NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (parent && ignored.contains(parent)) return win.NodeFilter.FILTER_REJECT;
      return win.NodeFilter.FILTER_ACCEPT;
    },
  };
  const walker = doc.createTreeWalker(line, win.NodeFilter.SHOW_TEXT, filter);
  const range = doc.createRange();
  const yPad = 3;
  let right = anchorRect.right;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    range.selectNodeContents(node);
    for (const rect of Array.from(range.getClientRects())) {
      const sameVisualRow = rect.bottom >= anchorRect.top - yPad && rect.top <= anchorRect.bottom + yPad;
      if (sameVisualRow) right = Math.max(right, rect.right);
    }
  }
  range.detach();
  return right;
}

/**
 * `@@scomment [text]` — an always-visible side annotation. On wide layouts the
 * card is absolutely positioned and therefore does not alter CM6's height map;
 * CSS switches it back into flow on narrow layouts.
 */
class SideCommentWidget extends MeasuredWidget {
  cmd: InlineCommand;

  constructor(cmd: InlineCommand) {
    super();
    this.cmd = cmd;
  }

  protected measureKey(): string { return ""; }
  protected get measuredBlock(): boolean { return false; }

  eq(other: SideCommentWidget): boolean {
    return this.cmd.context === other.cmd.context
      && this.cmd.fullFrom === other.cmd.fullFrom
      && this.cmd.fullTo === other.cmd.fullTo;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "inline-side-comment-widget inline-command-token";
    wrap.dataset.cmSourceFrom = String(this.cmd.fullFrom);
    wrap.dataset.cmSourceTo = String(this.cmd.fullTo);
    wrap.dataset.cmOpenSource = "true";
    wrap.setAttribute("role", "note");
    wrap.setAttribute("aria-label", "Side comment");

    const anchor = document.createElement("span");
    anchor.className = "inline-side-comment-anchor";
    anchor.setAttribute("aria-hidden", "true");

    const connector = document.createElement("span");
    connector.className = "inline-side-comment-connector";
    connector.setAttribute("aria-hidden", "true");

    const card = document.createElement("span");
    card.className = "inline-side-comment-card";
    card.innerHTML = inlineTodoBodyHTML(this.cmd.context.trim());

    anchor.append(connector);
    wrap.append(anchor, card);

    view.requestMeasure({
      read: () => {
        if (!wrap.isConnected) return null;
        const line = wrap.closest(".cm-line") as HTMLElement | null;
        const scroll = wrap.closest(".cm-scroller") as HTMLElement | null;
        const lineRect = line?.getBoundingClientRect();
        const scrollRect = scroll?.getBoundingClientRect() ?? view.dom.getBoundingClientRect();
        const wrapRect = wrap.getBoundingClientRect();
        const anchorRect = anchor.getBoundingClientRect();
        const connectorRect = connector.getBoundingClientRect();
        const cardRect = card.getBoundingClientRect();
        if (!line || !lineRect || !cardRect.width || !anchorRect.width) return null;

        const gap = 14;
        const minLeft = anchorRect.right + gap;
        const preferredRailLeft = scrollRect.right - cardRect.width - 120;
        const textSafeLeft = visualLineTextRight(line, anchorRect, card) + gap;
        const cardLeft = Math.max(minLeft, preferredRailLeft, textSafeLeft);
        return {
          cardLeft: cardLeft - wrapRect.left,
          connectorWidth: Math.max(12, cardLeft - connectorRect.left),
        };
      },
      write: (placement) => {
        if (!placement) return;
        wrap.style.setProperty("--side-comment-card-left", `${Math.round(placement.cardLeft)}px`);
        wrap.style.setProperty("--side-comment-connector-width", `${Math.round(placement.connectorWidth)}px`);
      },
    });

    return wrap;
  }

  ignoreEvent(): boolean { return false; }
}

// ---------------------------------------------------------------------------
// ViewPlugin
// ---------------------------------------------------------------------------

function excludedCommandRanges(view: EditorView): Array<{ from: number; to: number }> {
  const math = blockMathRangesOverlapping(view.state, view.visibleRanges).map(({ from, to }) => ({ from, to }));
  const inlineMath = view.visibleRanges.flatMap(({ from, to }) =>
    scanInlineMathRanges(view.state.doc.sliceString(from, to), from));
  const code = scanCodeRanges(view.state, view.visibleRanges);
  return mergeOverlappingRanges([...math, ...inlineMath, ...code]);
}

function pushHiddenPlanningBodyLines(
  decos: Range<Decoration>[],
  doc: EditorView["state"]["doc"],
  bodyFrom: number,
  blockTo: number,
  className: string,
): void {
  let start = bodyFrom;
  if (doc.sliceString(start, Math.min(start + 1, doc.length)) === "\n") start += 1;
  if (start >= blockTo) return;
  const firstLine = doc.lineAt(start).number;
  const lastLine = doc.lineAt(Math.max(start, blockTo - 1)).number;
  for (let lineNo = firstLine; lineNo <= lastLine; lineNo++) {
    const line = doc.line(lineNo);
    decos.push(Decoration.line({ class: className }).range(line.from));
  }
}

function buildInlineCommandDecos(
  view: EditorView,
  excludedRanges: Array<{ from: number; to: number }>,
): DecorationSet {
  const decos: Range<Decoration>[] = [];
  const sel = view.state.selection.main;
  const doc = view.state.doc;

  for (const { from: vFrom, to: vTo } of view.visibleRanges) {
    const text = doc.sliceString(vFrom, vTo);
    for (const cmd of visibleInlineCommands(text)) {
      const from = vFrom + cmd.fullFrom;
      const to = vFrom + cmd.fullTo;
      const blockTo = vFrom + (cmd.blockTo ?? cmd.fullTo);
      if (positionInsideAnyRange(from, excludedRanges)) continue;
      const cursorInside = sel.from <= blockTo && sel.to >= from;
      if (cmd.name === "itodo" && !cursorInside) {
        if (cmd.blockBodyFrom !== undefined && cmd.blockTo !== undefined) {
          decos.push(Decoration.line({ class: "cm-itodo-block-anchor-line" }).range(doc.lineAt(from).from));
        }
        decos.push(
          Decoration.replace({
            widget: new TodoWidget({
              ...cmd,
              fullFrom: from,
              fullTo: to,
              blockBodyFrom: cmd.blockBodyFrom === undefined ? undefined : vFrom + cmd.blockBodyFrom,
              blockTo,
            }),
          }).range(from, to),
        );
        if (cmd.blockBodyFrom !== undefined && cmd.blockTo !== undefined) {
          pushHiddenPlanningBodyLines(decos, doc, vFrom + cmd.blockBodyFrom, blockTo, "cm-itodo-block-hidden-line");
        }
      }
      if ((cmd.name === "todo" || PLANNING_BLOCK_NAMES.has(cmd.name)) && !cursorInside) {
        if (cmd.blockBodyFrom !== undefined && cmd.blockTo !== undefined) {
          decos.push(Decoration.line({ class: "cm-planning-block-anchor-line" }).range(doc.lineAt(from).from));
        }
        decos.push(
          Decoration.replace({
            widget: new PlanningBlockWidget({
              ...cmd,
              fullFrom: from,
              fullTo: to,
              blockBodyFrom: cmd.blockBodyFrom === undefined ? undefined : vFrom + cmd.blockBodyFrom,
              blockTo,
            }),
          }).range(from, to),
        );
        if (cmd.blockBodyFrom !== undefined && cmd.blockTo !== undefined) {
          pushHiddenPlanningBodyLines(decos, doc, vFrom + cmd.blockBodyFrom, blockTo, "cm-planning-block-hidden-line");
        }
      }
      if (cmd.name === "tag") {
        const tag = cleanTag(cmd.context);
        if (!tag) continue;
        if (!cursorInside) {
          decos.push(
            Decoration.replace({
              widget: new TagWidget(tag, from, to),
            }).range(from, to),
          );
        }
      }
      if (cmd.name === "latexmk" && !cursorInside) {
        decos.push(
          Decoration.replace({ widget: new LatexMarkWidget(cmd.switchValue.toLowerCase(), from, to) }).range(from, to),
        );
      }
      // `@@slides(reveal) []` is a structural marker for the Reveal deck.  It
      // deliberately disappears in Noema's editable preview but remains
      // available whenever the cursor enters it, just like the other source
      // backed widgets.
      if (cmd.name === "slides" && ["reveal", "vertical"].includes(cmd.switchValue.toLowerCase()) && !cursorInside) {
        decos.push(Decoration.replace({}).range(from, to));
      }
      if (cmd.name === "comment" && !cursorInside) {
        decos.push(
          Decoration.replace({
            widget: new InlineCommentWidget({ ...cmd, fullFrom: from, fullTo: to }),
          }).range(from, to),
        );
      }
      if (cmd.name === "revision" && !cursorInside) {
        decos.push(
          Decoration.replace({
            widget: new RevisionWidget({ ...cmd, fullFrom: from, fullTo: to }),
          }).range(from, to),
        );
      }
      if (cmd.name === "scomment" && !cursorInside) {
        decos.push(
          Decoration.replace({
            widget: new SideCommentWidget({ ...cmd, fullFrom: from, fullTo: to }),
          }).range(from, to),
        );
      }
      if (cmd.name === "cite" && !cursorInside) {
        decos.push(
          Decoration.replace({
            widget: new CiteWidget({ ...cmd, fullFrom: from, fullTo: to }),
          }).range(from, to),
        );
      }
    }
  }

  decos.sort((a, b) => a.from - b.from || a.to - b.to);
  return Decoration.set(decos, true);
}

function activeInlineCommandKey(view: EditorView): string {
  const sel = view.state.selection.main;
  // Range selection keeps command/citation widgets rendered. Returning a key
  // containing the moving endpoints made a wide drag rebuild the entire
  // visible command layer once per pointer event.
  if (!sel.empty) return "";
  const firstLine = view.state.doc.lineAt(sel.from).number;
  const lastLine = view.state.doc.lineAt(Math.min(sel.to, view.state.doc.length)).number;
  const keys: string[] = [];

  const scanFromLine = Math.max(1, firstLine - 80);
  const scanToLine = Math.min(view.state.doc.lines, lastLine + 80);
  const scanFrom = view.state.doc.line(scanFromLine).from;
  const scanTo = view.state.doc.line(scanToLine).to;
  const localText = view.state.doc.sliceString(scanFrom, scanTo);
  const localInlineMathRanges = scanInlineMathRanges(localText, scanFrom);
  for (const cmd of visibleInlineCommands(localText)) {
    const from = scanFrom + cmd.fullFrom;
    const to = scanFrom + (cmd.blockTo ?? cmd.fullTo);
    if (positionInsideAnyRange(from, localInlineMathRanges)) continue;
    if (sel.from <= to && sel.to >= from) keys.push(`${from}:${to}`);
  }
  if (keys.length > 0) return keys.join("|");

  for (let lineNum = firstLine; lineNum <= lastLine; lineNum++) {
    const line = view.state.doc.line(lineNum);
    const inlineMathRanges = scanInlineMathRanges(line.text, line.from);
    for (const cmd of visibleInlineCommands(line.text)) {
      const from = line.from + cmd.fullFrom;
      const to = line.from + cmd.fullTo;
      if (positionInsideAnyRange(from, inlineMathRanges)) continue;
      if (sel.from <= to && sel.to >= from) keys.push(`${from}:${to}`);
    }
  }
  return keys.join("|");
}

class TodoPlugin {
  decorations: DecorationSet;
  excludedRanges: Array<{ from: number; to: number }>;
  private activeCommandKey: string;

  constructor(view: EditorView) {
    this.excludedRanges = excludedCommandRanges(view);
    this.activeCommandKey = activeInlineCommandKey(view);
    this.decorations = buildInlineCommandDecos(view, this.excludedRanges);
  }

  update(update: ViewUpdate): void {
    if (update.view.compositionStarted && update.selectionSet && !update.docChanged && !update.viewportChanged) return;
    if (update.docChanged && window.AaronnoteBibliography?.mapChanges) {
      const changes: Array<{
        from: number;
        to: number;
        insertedLength: number;
        insertedText: string;
        deletedText: string;
      }> = [];
      update.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
        changes.push({
          from,
          to,
          insertedLength: inserted.length,
          insertedText: inserted.toString(),
          deletedText: update.startState.doc.sliceString(from, to),
        });
      });
      window.AaronnoteBibliography.mapChanges(changes);
    }
    if (update.docChanged || update.viewportChanged || hasViewportDecorationRefresh(update)) {
      this.excludedRanges = excludedCommandRanges(update.view);
      this.activeCommandKey = activeInlineCommandKey(update.view);
      this.decorations = buildInlineCommandDecos(update.view, this.excludedRanges);
    } else if (update.selectionSet) {
      const nextCommandKey = activeInlineCommandKey(update.view);
      if (nextCommandKey === this.activeCommandKey) return;
      this.activeCommandKey = nextCommandKey;
      this.decorations = buildInlineCommandDecos(update.view, this.excludedRanges);
    }
  }
}

export const inlineCommandsExtension = ViewPlugin.fromClass(TodoPlugin, {
  decorations: (v) => v.decorations,
});
