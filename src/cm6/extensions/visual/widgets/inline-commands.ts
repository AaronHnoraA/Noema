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
import { decodeRevisionAttribute, decodeRevisionContext } from "../../../../authoring-syntax.ts";
import { revisionKindOf } from "../../../../revision-kinds.ts";
import { findInlineCommandClose, isEscapedCommandStart, parseCommandArgs, scanInlineCommands, type InlineCommand } from "../../../../command-syntax.ts";
import { renderInlineMarkdownHTML } from "../../../../render-html.ts";
import { StateField, type Range, type Text, type Transaction } from "@codemirror/state";
import { isPointerSelecting, updateHasPointerSelectionEffect, visualSelection } from "../selection.ts";
import {
  dispatchConstructEdit,  constructSources,
  constructViewPlugin,
  drawnConstructSource,
  literalRangesIn,
  selectionOpensSource,
} from "../constructs/index.ts";
import { positionInsideAnyRange } from "../../../math-ranges.ts";
import {
  DATE_KEYS,
  DATE_KEY_LABELS,
  formatDateValue,
  parseDateValue,
  relativeDateClass,
  relativeDateLabel,
} from "../../../../date-syntax.ts";
import { latexMark } from "../../../../../shared/latex-marks.mjs";

declare global {
  interface Window {
    NoemaBibliography?: {
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
  return [...blocks, ...inline]
    .filter((command) => !isEscapedCommandStart(text, command.fullFrom))
    .sort((a, b) => a.fullFrom - b.fullFrom || a.fullTo - b.fullTo);
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
      body.innerHTML = renderInlineMarkdownHTML(cmd.context.trim());
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
    title.innerHTML = renderInlineMarkdownHTML(cmd.context.trim());
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
      content.innerHTML = context ? renderInlineMarkdownHTML(context) : "";
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
    content.innerHTML = context ? renderInlineMarkdownHTML(context) : "";
    content.addEventListener("mousedown", stopWidgetEventPropagation);

    wrap.append(button, content);
    return wrap;
  }

  ignoreEvent(): boolean { return false; }
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
    const original = decodeRevisionContext(this.cmd.context.trim());
    const advice = decodeRevisionAttribute(this.cmd.args.advice || "");
    const reason = decodeRevisionAttribute(this.cmd.args.reason || "");
    const kind = revisionKindOf(this.cmd.switchValue);
    const wrap = document.createElement("span");
    wrap.className = "noema-revision inline-command-token";
    wrap.dataset.revisionStyle = kind.id;
    wrap.dataset.cmSourceFrom = String(this.cmd.fullFrom);
    wrap.dataset.cmSourceTo = String(this.cmd.fullTo);
    wrap.setAttribute("role", "note");
    wrap.setAttribute("aria-label", `Revision: replace ${original} with ${advice || "missing advice"}`);

    const shown = document.createElement("span");
    shown.className = "noema-revision-original";
    shown.innerHTML = renderInlineMarkdownHTML(original);
    shown.tabIndex = 0;

    const card = document.createElement("span");
    card.className = "noema-revision-card";
    const label = document.createElement("strong");
    label.textContent = kind.label;
    const replacement = document.createElement("span");
    replacement.className = "noema-revision-advice";
    replacement.innerHTML = advice ? renderInlineMarkdownHTML(advice) : "Missing advice";
    card.append(label, replacement);
    if (reason) {
      const why = document.createElement("span");
      why.className = "noema-revision-reason";
      why.textContent = reason;
      card.append(why);
    }
    const actions = document.createElement("span");
    actions.className = "noema-revision-actions";
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
        dispatchConstructEdit(view, {
          changes: { from: this.cmd.fullFrom, to: this.cmd.fullTo, insert: advice },
          selection: { anchor: this.cmd.fullFrom + advice.length },
          scrollIntoView: true,
        });
        view.focus();
      }),
      action("Keep", "Keep the original text", () => {
        dispatchConstructEdit(view, {
          changes: { from: this.cmd.fullFrom, to: this.cmd.fullTo, insert: original },
          selection: { anchor: this.cmd.fullFrom + original.length },
          scrollIntoView: true,
        });
        view.focus();
      }),
      // Selecting the whole raw command used to be the only "edit": the next
      // keypress then destroyed it. Ask the shell for the revision form
      // instead, and fall back to selecting the source if nothing answers.
      action("Edit", "Edit this revision", () => {
        const detail = {
          from: this.cmd.fullFrom,
          to: this.cmd.fullTo,
          original,
          advice,
          reason,
          style: kind.id,
        };
        const handled = !view.dom.dispatchEvent(new CustomEvent("noema-edit-revision", {
          detail,
          bubbles: true,
          cancelable: true,
        }));
        if (!handled) {
          view.dispatch({
            selection: { anchor: this.cmd.fullFrom, head: this.cmd.fullTo },
            scrollIntoView: true,
          });
        }
        view.focus();
      }),
    );
    card.append(actions);
    wrap.append(shown, card);
    return wrap;
  }

  // Every other inline command widget lets events through. Swallowing them here
  // meant a click could not place the caret inside the revision, leaving the
  // toolbar button as the only way in.
  ignoreEvent(): boolean { return false; }
}

class CiteWidget extends MeasuredWidget {
  cmd: InlineCommand;
  bibliographyVersion: number;

  constructor(cmd: InlineCommand) {
    super();
    this.cmd = cmd;
    this.bibliographyVersion = window.NoemaBibliography?.version?.() ?? 0;
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
  const cite = window.NoemaBibliography?.citationLabel?.(cmd.fullFrom, cmd.fullTo);
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
    window.NoemaBibliography?.openCitation?.(cmd.fullFrom, cmd.fullTo, wrap.getBoundingClientRect(), true);
  });
  wrap.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") return;
    event.preventDefault();
    event.stopPropagation();
    window.NoemaBibliography?.openCitation?.(cmd.fullFrom, cmd.fullTo, wrap.getBoundingClientRect(), true);
  });
  wrap.addEventListener("contextmenu", (event) => {
    const handler = window.NoemaBibliography?.contextMenu;
    if (!handler) return;
    event.preventDefault();
    event.stopPropagation();
    handler(cmd.fullFrom, cmd.fullTo, event.clientX, event.clientY);
  });
  return wrap;
}

/**
 * `@@scomment [text]` — an always-visible side annotation. On wide layouts the
 * card is absolutely positioned to the right of the text column (placed by
 * `sideCommentLayoutExtension`), so it does not alter CM6's height map; CSS
 * switches it back into flow on narrow layouts.
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
    card.innerHTML = renderInlineMarkdownHTML(this.cmd.context.trim());

    anchor.append(connector);
    wrap.append(anchor, card);

    view.plugin(sideCommentLayoutPlugin)?.schedule();
    return wrap;
  }

  // Typing elsewhere shifts the source offsets and a decoration refresh then
  // rebuilds this widget. Reusing the DOM keeps the card where it was placed
  // instead of redrawing it at the default position and re-rendering math.
  updateDOM(dom: HTMLElement, view: EditorView, previous: SideCommentWidget): boolean {
    if (!dom.classList.contains("inline-side-comment-widget")) return false;
    dom.dataset.cmSourceFrom = String(this.cmd.fullFrom);
    dom.dataset.cmSourceTo = String(this.cmd.fullTo);
    if (previous.cmd.context !== this.cmd.context) {
      const card = dom.querySelector<HTMLElement>(".inline-side-comment-card");
      if (!card) return false;
      card.innerHTML = renderInlineMarkdownHTML(this.cmd.context.trim());
    }
    view.plugin(sideCommentLayoutPlugin)?.schedule();
    return true;
  }

  ignoreEvent(): boolean { return false; }
}

// ---------------------------------------------------------------------------
// ViewPlugin
// ---------------------------------------------------------------------------

function excludedCommandRanges(view: EditorView): Array<{ from: number; to: number }> {
  return literalRangesIn(view.state, view.visibleRanges);
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
  const doc = view.state.doc;

  for (const { from: vFrom, to: vTo } of view.visibleRanges) {
    const text = doc.sliceString(vFrom, vTo);
    for (const cmd of visibleInlineCommands(text)) {
      const from = vFrom + cmd.fullFrom;
      const to = vFrom + cmd.fullTo;
      const blockTo = vFrom + (cmd.blockTo ?? cmd.fullTo);
      if (positionInsideAnyRange(from, excludedRanges)) continue;
      // A range keeps commands rendered, as `activeInlineCommandKey` assumes;
      // only a caret opens one's source. Vim edits commands as text.
      const cursorInside = selectionOpensSource(view.state, from, blockTo, "caret-edge", "structure");
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
  const sel = visualSelection(view.state).main;
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
  // The same literal ranges the decoration builder skips.
  const literal = literalRangesIn(view.state, [{ from: scanFrom, to: scanTo }]);
  for (const cmd of visibleInlineCommands(localText)) {
    const from = scanFrom + cmd.fullFrom;
    const to = scanFrom + (cmd.blockTo ?? cmd.fullTo);
    if (positionInsideAnyRange(from, literal)) continue;
    if (selectionOpensSource(view.state, from, to, "caret-edge", "structure")) keys.push(`${from}:${to}`);
  }
  if (keys.length > 0) return keys.join("|");

  for (let lineNum = firstLine; lineNum <= lastLine; lineNum++) {
    const line = view.state.doc.line(lineNum);
    const lineLiteral = literalRangesIn(view.state, [{ from: line.from, to: line.to }]);
    for (const cmd of visibleInlineCommands(line.text)) {
      const from = line.from + cmd.fullFrom;
      const to = line.from + cmd.fullTo;
      if (positionInsideAnyRange(from, lineLiteral)) continue;
      if (selectionOpensSource(view.state, from, to, "caret-edge", "structure")) keys.push(`${from}:${to}`);
    }
  }
  return keys.join("|");
}

/** Keep the bibliography's citation positions in step with every edit. */
function mapBibliographyPositions(update: ViewUpdate): void {
  if (!update.docChanged || !window.NoemaBibliography?.mapChanges) return;
  const changes: Array<{ from: number; to: number; insertedLength: number; insertedText: string; deletedText: string }> = [];
  update.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
    changes.push({
      from,
      to,
      insertedLength: inserted.length,
      insertedText: inserted.toString(),
      deletedText: update.startState.doc.sliceString(from, to),
    });
  });
  window.NoemaBibliography.mapChanges(changes);
}

export const inlineCommandsExtension = constructViewPlugin<Array<{ from: number; to: number }>>({
  build: buildInlineCommandDecos,
  revealKey: (view) => activeInlineCommandKey(view),
  // The literal ranges commands skip, kept with the decorations.
  extra: {
    create: excludedCommandRanges,
    map: (ranges, update) => ranges.map((range) => ({
      from: update.changes.mapPos(range.from, -1),
      to: update.changes.mapPos(range.to, 1),
    })),
  },
  beforeUpdate: mapBibliographyPositions,
  provide: (plugin) => constructSources.of(drawnConstructSource(
    "inline-command", "structure", (_state, view) => view?.plugin(plugin)?.decorations)),
});

// ---------------------------------------------------------------------------
// Side-comment layout
// ---------------------------------------------------------------------------

const SIDE_COMMENT_GAP_PX = 10;
const SIDE_COMMENT_NARROW = "(max-width: 900px)";

function setPx(el: HTMLElement, name: string, value: number): void {
  const next = `${Math.round(value)}px`;
  if (el.style.getPropertyValue(name) !== next) el.style.setProperty(name, next);
}

function docHasSideComment(doc: Text): boolean {
  for (const iter = doc.iterLines(); !iter.next().done;) {
    if (iter.value.includes("@@scomment")) return true;
  }
  return false;
}

/** Whether an edit's changed lines, before or after, mention a side comment. */
function editTouchesSideComment(tr: Transaction): boolean {
  let hit = false;
  const touches = (doc: Text, from: number, to: number) =>
    doc.sliceString(doc.lineAt(from).from, doc.lineAt(to).to).includes("scomment");
  tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    if (!hit) hit = touches(tr.startState.doc, fromA, toA) || touches(tr.newDoc, fromB, toB);
  });
  return hit;
}

/**
 * Whether the note has side comments, and so lets the page scroll sideways to
 * reach cards past the text column. The class goes through `editorAttributes` because CM6 owns the editor's class
 * attribute and rewrites it on focus and other updates. The full scan runs
 * only at startup and when an edit touches `@@scomment`.
 */
const sideCommentRailField = StateField.define<boolean>({
  create: (state) => docHasSideComment(state.doc),
  update: (on, tr) => (tr.docChanged && editTouchesSideComment(tr) ? docHasSideComment(tr.newDoc) : on),
  provide: (field) => EditorView.editorAttributes.from(field, (on): Record<string, string> => (on ? { class: "has-side-comments" } : {})),
});

/**
 * Lays out every visible `@@scomment` card in one pass, just right of the
 * text column so no card covers prose. Cards keep their line's height when
 * they can and are pushed down just far enough to clear the card above when
 * they cannot.
 */
class SideCommentLayout {
  private view: EditorView;

  constructor(view: EditorView) {
    this.view = view;
    this.schedule();
  }

  private get hasRail(): boolean {
    return this.view.state.field(sideCommentRailField);
  }

  update(update: ViewUpdate): void {
    if (!this.hasRail) return;
    // Selection matters because a card turns back into source under the cursor.
    // Its layout stays fixed through the gesture, including edge scrolling.
    if (isPointerSelecting(update.state) && update.selectionSet
        && !update.docChanged && !update.viewportChanged && !update.geometryChanged) return;
    const pointerSettled = updateHasPointerSelectionEffect(update);
    if (update.docChanged || update.viewportChanged || update.geometryChanged
      || update.heightChanged || update.selectionSet || update.focusChanged
      || pointerSettled) this.schedule();
  }

  schedule(): void {
    this.view.requestMeasure({ key: this, read: () => this.read(), write: (layout) => this.write(layout) });
  }

  private read() {
    if (!this.hasRail) return null;
    const win = this.view.dom.ownerDocument.defaultView;
    if (win?.matchMedia(SIDE_COMMENT_NARROW).matches) return null;
    const widgets = Array.from(this.view.contentDOM.querySelectorAll<HTMLElement>(".inline-side-comment-widget"));
    let floor = -Infinity;
    return widgets.flatMap((wrap) => {
      const line = wrap.closest(".cm-line");
      const card = wrap.querySelector<HTMLElement>(".inline-side-comment-card");
      const connector = wrap.querySelector<HTMLElement>(".inline-side-comment-connector");
      if (!line || !card || !connector) return [];
      const shift = parseFloat(wrap.style.getPropertyValue("--side-comment-shift")) || 0;
      const cardRect = card.getBoundingClientRect();
      const naturalTop = cardRect.top - shift;
      const nextShift = Math.max(0, floor + SIDE_COMMENT_GAP_PX - naturalTop);
      floor = naturalTop + nextShift + cardRect.height;
      const cardLeft = line.getBoundingClientRect().right + 1.5 * SIDE_COMMENT_GAP_PX;
      return [{
        wrap,
        cardLeft: cardLeft - wrap.getBoundingClientRect().left,
        connectorWidth: Math.max(12, cardLeft - connector.getBoundingClientRect().left),
        shift: nextShift,
      }];
    });
  }

  private write(layout: ReturnType<SideCommentLayout["read"]>): void {
    for (const { wrap, cardLeft, connectorWidth, shift } of layout ?? []) {
      setPx(wrap, "--side-comment-card-left", cardLeft);
      setPx(wrap, "--side-comment-connector-width", connectorWidth);
      setPx(wrap, "--side-comment-shift", shift);
      if (!wrap.dataset.placed) wrap.dataset.placed = "true";
    }
  }

}

const sideCommentLayoutPlugin = ViewPlugin.fromClass(SideCommentLayout);

export const sideCommentLayoutExtension = [sideCommentRailField, sideCommentLayoutPlugin];
