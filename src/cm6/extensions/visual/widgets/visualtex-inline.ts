/*
 * Inline MathLive adapter extracted and adapted from VisualTeX's
 * apps/macos/src/editor/MathEditor.tsx.
 *
 * Upstream: https://github.com/paulhe666/visualtex
 * Revision: 5e3ed2a56ba53643a463c6ea4c2cf1a5675e691c
 * Copyright (c) paulhe666
 * SPDX-License-Identifier: MIT
 */

import type { MathfieldElement, Selector } from "mathlive";
import "mathlive/fonts.css";
import { normalizeVisualTexLatex } from "../../../../tex-compat.ts";

export { normalizeVisualTexLatex } from "../../../../tex-compat.ts";

export type VisualTexInlineEntry =
  | { kind: "all" }
  | { kind: "start" }
  | { kind: "end" }
  | { kind: "point"; x: number; y: number };

export type VisualTexInlineMoveDirection =
  | "forward"
  | "backward"
  | "upward"
  | "downward"
  | "submit"
  | "save";

export type VisualTexInlineEditorOptions = {
  latex: string;
  macros: Record<string, string>;
  entry: VisualTexInlineEntry;
  onInput: (latex: string) => void;
  onCommit: (direction?: VisualTexInlineMoveDirection) => void;
  onUnavailable: (error: unknown) => void;
  advanced?: boolean;
  commitOnBlur?: boolean;
  toolbarHost?: HTMLElement;
};

export type VisualTexInlineEditor = {
  readonly ready: Promise<void>;
  value(): string;
  focus(): void;
  destroy(): void;
};

export type VisualTexMathCompletionRequest = {
  prefix: string;
  rect: { left: number; top: number; bottom: number };
  apply: (template: string | VisualTexCompletionTemplate, deleteBefore: number) => boolean;
  applyLayout?: (layout: VisualTexDisplayLayout, deleteBefore: number) => boolean;
};

export type VisualTexCompletionTemplate = {
  latex: string;
  needsFinalSourceBoundary?: boolean;
  tabstops: Array<{
    index: number;
    primaryId: string;
    promptIds: string[];
  }>;
};

export type VisualTexMathHostKey = {
  key: string;
  code?: string;
  text?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
};

export function visualTexBracketDirection(
  key: VisualTexMathHostKey,
): "forward" | "backward" | null {
  if (!(key.metaKey || key.ctrlKey) || key.altKey) return null;
  const tokens = [key.code, key.key].filter((token): token is string => Boolean(token));
  if (tokens.some((token) => token === "]" || /^bracketright$/i.test(token))) return "forward";
  if (tokens.some((token) => token === "[" || /^bracketleft$/i.test(token))) return "backward";
  return null;
}

type VisualTexStyleTarget = Pick<MathfieldElement, "selection" | "lastOffset" | "applyStyle">;

export function visualTexStyleRange(field: VisualTexStyleTarget): [number, number] {
  const selected = field.selection.ranges.find(([from, to]) => from !== to);
  return selected
    ? [Math.min(selected[0], selected[1]), Math.max(selected[0], selected[1])]
    : [0, Math.max(0, field.lastOffset)];
}

export function applyVisualTexStyle(
  field: VisualTexStyleTarget,
  style: "color" | "backgroundColor",
  color: string,
  range = visualTexStyleRange(field),
): [number, number] {
  const patch = style === "color" ? { color } : { backgroundColor: color };
  field.applyStyle(patch, { range, operation: "set" });
  withVisualTexUndoRecordingSuspended(field as object, () => {
    field.selection = { ranges: [[range[0], range[1]]], direction: "forward" };
  });
  return range;
}

type EnvironmentToken = {
  kind: "begin" | "end";
  name: string;
  end: number;
};

type MathLiveModule = typeof import("mathlive");

let mathLivePromise: Promise<MathLiveModule> | null = null;

function loadMathLive(): Promise<MathLiveModule> {
  mathLivePromise ??= import("mathlive");
  return mathLivePromise;
}

function isEscaped(source: string, index: number): boolean {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor--) slashCount++;
  return slashCount % 2 === 1;
}

function readEnvironmentToken(source: string, index: number): EnvironmentToken | null {
  if (source[index] !== "\\") return null;
  const match = source.slice(index).match(/^\\(begin|end)\{([A-Za-z]+\*?)\}/);
  if (!match) return null;
  return {
    kind: match[1] as EnvironmentToken["kind"],
    name: match[2]!,
    end: index + match[0].length,
  };
}

function updateEnvironmentStack(stack: string[], token: EnvironmentToken): void {
  if (token.kind === "begin") {
    stack.push(token.name);
    return;
  }
  const matchingIndex = stack.lastIndexOf(token.name);
  if (matchingIndex >= 0) stack.splice(matchingIndex, 1);
}

/**
 * Match VisualTeX's logical-row boundary: split only on a top-level `\\`,
 * never inside braces, comments, or a nested begin/end environment. Optional
 * TeX row spacing such as `\\[2pt]` belongs to the separator, not either row.
 */
function splitTopLevelDisplayRows(source: string): string[] {
  const rows: string[] = [];
  let current = "";
  let braceDepth = 0;
  const environments: string[] = [];

  for (let index = 0; index < source.length; index++) {
    const token = readEnvironmentToken(source, index);
    if (token) {
      current += source.slice(index, token.end);
      updateEnvironmentStack(environments, token);
      index = token.end - 1;
      continue;
    }

    const character = source[index]!;
    if (character === "%" && !isEscaped(source, index)) {
      const lineEnd = source.indexOf("\n", index);
      if (lineEnd < 0) {
        current += source.slice(index);
        break;
      }
      current += source.slice(index, lineEnd + 1);
      index = lineEnd;
      continue;
    }

    if (character === "{" && !isEscaped(source, index)) braceDepth++;
    else if (character === "}" && !isEscaped(source, index)) braceDepth = Math.max(0, braceDepth - 1);

    if (
      character === "\\"
      && source[index + 1] === "\\"
      && braceDepth === 0
      && environments.length === 0
    ) {
      rows.push(current.trim());
      current = "";
      index++;
      let cursor = index + 1;
      while (/\s/.test(source[cursor] ?? "")) cursor++;
      if (source[cursor] === "[") {
        const closingBracket = source.indexOf("]", cursor + 1);
        if (closingBracket >= 0) cursor = closingBracket + 1;
      }
      while (/\s/.test(source[cursor] ?? "")) cursor++;
      index = cursor - 1;
      continue;
    }
    current += character;
  }

  if (current.trim() || rows.length === 0) rows.push(current.trim());
  return rows.length ? rows : [""];
}

const multilineDisplayEnvironments = new Set([
  "align",
  "align*",
  "alignat",
  "alignat*",
  "aligned",
  "gather",
  "gather*",
  "gathered",
  "multline",
  "multline*",
  "split",
  "lines",
  "eqnarray",
]);

const alignmentDisplayEnvironments = new Set([
  "align",
  "align*",
  "alignat",
  "alignat*",
  "aligned",
  "split",
  "eqnarray",
]);

type DisplayEnvelope = {
  open: string;
  close: string;
  alignRelations: boolean;
};

type DisplayDocument = {
  rows: string[];
  envelope: DisplayEnvelope | null;
};

function stripTopLevelAlignmentMarkers(latex: string): string {
  let result = "";
  let braceDepth = 0;
  const environments: string[] = [];
  for (let index = 0; index < latex.length; index++) {
    const token = readEnvironmentToken(latex, index);
    if (token) {
      result += latex.slice(index, token.end);
      updateEnvironmentStack(environments, token);
      index = token.end - 1;
      continue;
    }
    const character = latex[index]!;
    if (character === "{" && !isEscaped(latex, index)) braceDepth++;
    else if (character === "}" && !isEscaped(latex, index)) braceDepth = Math.max(0, braceDepth - 1);
    if (
      character === "&"
      && !isEscaped(latex, index)
      && braceDepth === 0
      && environments.length === 0
    ) continue;
    result += character;
  }
  return result.trim();
}

const relationCommands = [
  "\\Longleftrightarrow", "\\Longrightarrow", "\\Leftrightarrow", "\\Rightarrow",
  "\\leftrightarrow", "\\rightarrow", "\\leftarrow", "\\subseteq", "\\supseteq",
  "\\notin", "\\approx", "\\equiv", "\\simeq", "\\propto", "\\mapsto",
  "\\subset", "\\supset", "\\cong", "\\neq", "\\leq", "\\geq", "\\sim",
  "\\to", "\\ne", "\\le", "\\ge", "\\in",
] as const;

function findTopLevelRelationIndex(latex: string): number {
  let braceDepth = 0;
  const environments: string[] = [];
  for (let index = 0; index < latex.length; index++) {
    const token = readEnvironmentToken(latex, index);
    if (token) {
      updateEnvironmentStack(environments, token);
      index = token.end - 1;
      continue;
    }
    const character = latex[index]!;
    if (character === "{" && !isEscaped(latex, index)) {
      braceDepth++;
      continue;
    }
    if (character === "}" && !isEscaped(latex, index)) {
      braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }
    if (braceDepth !== 0 || environments.length !== 0) continue;
    if (character === "=" || character === "<" || character === ">") return index;
    if (character !== "\\") continue;
    for (const command of relationCommands) {
      if (!latex.startsWith(command, index)) continue;
      const next = latex[index + command.length];
      if (!next || !/[A-Za-z]/.test(next)) return index;
    }
  }
  return -1;
}

function addTopLevelAlignmentMarker(latex: string): string {
  const relation = findTopLevelRelationIndex(latex);
  return relation < 0 ? latex : `${latex.slice(0, relation)}&${latex.slice(relation)}`;
}

function parseDisplayDocument(source: string): DisplayDocument {
  const normalized = source.replace(/\r\n?/g, "\n").trim();
  const begin = normalized.match(/^\\begin\{([A-Za-z]+\*?)\}/);
  const name = begin?.[1] ?? "";
  const close = name ? `\\end{${name}}` : "";
  if (!begin || !multilineDisplayEnvironments.has(name) || !normalized.endsWith(close)) {
    return { rows: splitTopLevelDisplayRows(normalized), envelope: null };
  }

  let open = begin[0];
  let bodyFrom = open.length;
  if (name === "alignat" || name === "alignat*") {
    const argument = normalized.slice(bodyFrom).match(/^\s*\{[^{}]*\}/)?.[0] ?? "";
    open += argument;
    bodyFrom += argument.length;
  }
  const body = normalized.slice(bodyFrom, normalized.length - close.length).trim();
  const alignRelations = alignmentDisplayEnvironments.has(name);
  const rows = splitTopLevelDisplayRows(body)
    .map((row) => alignRelations ? stripTopLevelAlignmentMarkers(row) : row);
  return { rows, envelope: { open, close, alignRelations } };
}

export function splitVisualTexDisplayRows(source: string): string[] {
  return parseDisplayDocument(source).rows;
}

export function joinVisualTexDisplayRows(rows: readonly string[]): string {
  const normalized = rows.map((row) => row.trim());
  if (normalized.every((row) => row.length === 0)) return "";
  return normalized.join(" \\\\\n");
}

function serializeDisplayDocument(rows: readonly string[], envelope: DisplayEnvelope | null): string {
  const body = joinVisualTexDisplayRows(
    envelope?.alignRelations ? rows.map(addTopLevelAlignmentMarker) : rows,
  );
  if (!body || !envelope) return body;
  return `${envelope.open}\n${body}\n${envelope.close}`;
}

export function replaceVisualTexDisplayRows(source: string, rows: readonly string[]): string {
  return serializeDisplayDocument(rows, parseDisplayDocument(source).envelope);
}

export type VisualTexDisplayLayout =
  | "equation"
  | "align"
  | "align*"
  | "aligned"
  | "gather"
  | "gather*"
  | "gathered"
  | "split"
  | "multline"
  | "multline*"
  | "cases"
  | "matrix"
  | "pmatrix"
  | "bmatrix";

const managedDisplayLayouts = new Set<VisualTexDisplayLayout>([
  "align", "align*", "aligned", "gather", "gather*", "gathered", "split",
  "multline", "multline*", "cases", "matrix", "pmatrix", "bmatrix",
]);

function managedLayoutDocument(source: string): { layout: VisualTexDisplayLayout; rows: string[] } {
  const normalized = source.replace(/\r\n?/g, "\n").trim();
  const begin = normalized.match(/^\\begin\{([A-Za-z]+\*?)\}/);
  const name = begin?.[1] as VisualTexDisplayLayout | undefined;
  const close = name ? `\\end{${name}}` : "";
  if (!begin || !name || !managedDisplayLayouts.has(name) || !normalized.endsWith(close)) {
    return { layout: "equation", rows: parseDisplayDocument(normalized).rows };
  }
  const body = normalized.slice(begin[0].length, normalized.length - close.length).trim();
  const aligned = name === "align" || name === "align*" || name === "aligned"
    || name === "split" || name === "cases";
  return {
    layout: name,
    rows: splitTopLevelDisplayRows(body).map((row) => aligned ? stripTopLevelAlignmentMarkers(row) : row),
  };
}

export function visualTexDisplayLayout(source: string): VisualTexDisplayLayout {
  return managedLayoutDocument(source).layout;
}

export function visualTexOuterDisplayLayout(source: string): VisualTexDisplayLayout | null {
  const normalized = normalizeVisualTexLatex(source).trim();
  const begin = normalized.match(/^\\begin\{([A-Za-z]+\*?)\}/);
  const layout = begin?.[1] as VisualTexDisplayLayout | undefined;
  return begin && layout && managedDisplayLayouts.has(layout)
    && normalized.endsWith(`\\end{${layout}}`)
    ? layout
    : null;
}

export function visualTexSupportsRows(source: string): boolean {
  return visualTexDisplayLayout(source) !== "equation";
}

export function setVisualTexDisplayLayout(source: string, layout: VisualTexDisplayLayout): string {
  const { rows } = managedLayoutDocument(source);
  const cleanRows = rows.map((row) => row.trim()).filter((row, index) => row || index === 0);
  if (layout === "equation") return cleanRows.join(" \\qquad ").trim();
  const aligned = layout === "align" || layout === "align*" || layout === "aligned"
    || layout === "split" || layout === "cases";
  const body = joinVisualTexDisplayRows(aligned ? cleanRows.map(addTopLevelAlignmentMarker) : cleanRows);
  return body ? `\\begin{${layout}}\n${body}\n\\end{${layout}}` : "";
}

export function serializeVisualTexDisplayRows(
  layout: VisualTexDisplayLayout,
  rows: readonly string[],
): string {
  const cleanRows = rows.map((row) => normalizeVisualTexLatex(row).trim());
  if (layout === "equation") return cleanRows.filter(Boolean).join(" \\qquad ").trim();
  return setVisualTexDisplayLayout(joinVisualTexDisplayRows(cleanRows), layout);
}

export function prepareVisualTexDisplayLatex(source: string): string {
  const normalized = normalizeVisualTexLatex(source);
  const parsed = parseDisplayDocument(normalized);
  return !parsed.envelope && parsed.rows.length > 1
    ? setVisualTexDisplayLayout(normalized, "aligned")
    : normalized;
}

export function preloadVisualTexInlineEditor(): void {
  void loadMathLive();
}

function placeInitialSelection(field: MathfieldElement, entry: VisualTexInlineEntry): void {
  withVisualTexUndoRecordingSuspended(field, () => {
    if (entry.kind === "all") {
      field.executeCommand("selectAll");
      return;
    }
    if (entry.kind === "start") {
      field.position = 0;
      return;
    }
    if (entry.kind === "end") {
      field.position = field.lastOffset;
      return;
    }
    field.position = field.getOffsetFromPoint(entry.x, entry.y);
  });
  stopVisualTexUndoCoalescing(field);
}

function configureNoemaMathfield(field: MathfieldElement): void {
  field.smartMode = false;
  field.smartFence = false;
  field.smartSuperscript = false;
  field.removeExtraneousParentheses = false;
  // Disable MathLive's own math-space rewrite. The shared Noema key adapter
  // below distinguishes command termination and real text spaces; ignored TeX
  // source whitespace must never be turned into a visible spacing command.
  field.mathModeSpace = "";
  field.maxMatrixCols = 10;
  field.mathVirtualKeyboardPolicy = "manual";
}

const visualTexCaretRevealPending = new WeakSet<object>();

function composedParentElement(node: Node): HTMLElement | null {
  const parent = node.parentNode;
  if (parent instanceof HTMLElement) return parent;
  if (parent instanceof ShadowRoot && parent.host instanceof HTMLElement) return parent.host;
  return null;
}

/**
 * Reveal the MathLive caret only inside the formula's own horizontal
 * viewports. DOM `scrollIntoView()` is deliberately forbidden here: it walks
 * every scrollable ancestor and used to pull the entire CM6 page back to the
 * formula after a selection/focus event.
 */
export function revealVisualTexCaretHorizontally(
  field: MathfieldElement,
  caret: HTMLElement,
): void {
  const visualHost = field.closest<HTMLElement>("[data-cm-visual-math='active']");
  const viewports: HTMLElement[] = [];
  let current: HTMLElement | null = caret;
  while (current) {
    if (!viewports.includes(current)
        && current.clientWidth > 0
        && current.scrollWidth > current.clientWidth + 1) {
      viewports.push(current);
    }
    if (current === visualHost) break;
    current = composedParentElement(current);
  }

  for (const viewport of viewports) {
    const caretRect = caret.getBoundingClientRect();
    const viewportRect = viewport.getBoundingClientRect();
    if (![caretRect.left, caretRect.right, viewportRect.left, viewportRect.right]
      .every(Number.isFinite)) continue;
    const padding = Math.min(16, Math.max(4, viewport.clientWidth / 8));
    if (caretRect.left < viewportRect.left + padding) {
      viewport.scrollLeft -= viewportRect.left + padding - caretRect.left;
    } else if (caretRect.right > viewportRect.right - padding) {
      viewport.scrollLeft += caretRect.right - (viewportRect.right - padding);
    }
  }
}

export function revealVisualTexCaret(field: MathfieldElement): void {
  if (visualTexCaretRevealPending.has(field)) return;
  visualTexCaretRevealPending.add(field);
  requestAnimationFrame(() => {
    visualTexCaretRevealPending.delete(field);
    if (!field.isConnected) return;
    const caret = field.shadowRoot?.querySelector<HTMLElement>(
      ".ML__caret, .ML__text-caret, .ML__latex-caret",
    );
    if (caret) revealVisualTexCaretHorizontally(field, caret);
  });
}

function focusVisualTexField(field: MathfieldElement | null | undefined): void {
  if (!field) return;
  const focus = (field as unknown as { focus?: (options?: FocusOptions) => void }).focus;
  if (typeof focus !== "function") return;
  try {
    focus.call(field, { preventScroll: true });
  } catch (_) {
    // Older WebKit builds may reject FocusOptions. This fallback is retained
    // for compatibility; current Noema and xwidget WebKit both support it.
    focus.call(field);
  }
}

export function createNoemaMathfield(
  Constructor: MathLiveModule["MathfieldElement"],
): MathfieldElement {
  // Noema owns the only snippet index, popup, ranking and key handling used by
  // LiveTeX. MathLive warns when these are passed as public constructor
  // options, but its internal deferred option path is precisely what all
  // property setters use before mount. Install the empty shortcut dictionary
  // there so no native provider exists even during the mount microtask.
  Constructor.scientificNotationTemplate = null;
  const field = new Constructor();
  const nativeSnippetOptions = {
    inlineShortcuts: {},
    onInlineShortcut: () => "",
    popoverPolicy: "off",
    environmentPopoverPolicy: "off",
  };
  const deferred = field as unknown as {
    _setOptions?: (options: typeof nativeSnippetOptions) => void;
  };
  deferred._setOptions?.(nativeSnippetOptions);
  field.addEventListener("mount", () => {
    // Reassert the boundary against future MathLive deferred-state changes.
    field.inlineShortcuts = {};
    field.onInlineShortcut = () => "";
    field.popoverPolicy = "off";
    field.environmentPopoverPolicy = "off";
  }, { once: true });
  field.addEventListener("input", () => revealVisualTexCaret(field));
  field.addEventListener("selection-change", () => revealVisualTexCaret(field));
  field.addEventListener("focusin", () => revealVisualTexCaret(field));
  // Every MathLive selection command calls Mathfield.scrollIntoView(). Its
  // default first calls host.scrollIntoView({ inline: "nearest" }), which can
  // drag a wide display formula and the entire CM6 page back to the formula's
  // left edge. Supplying this callback disables that page-level branch while
  // retaining MathLive's own internal caret scrolling below it.
  field.onScrollIntoView = () => revealVisualTexCaret(field);
  configureNoemaMathfield(field);
  return field;
}

/** Read only standard TeX from MathLive; editor prompts never enter the note. */
export function visualTexMathfieldLatex(field: Pick<MathfieldElement, "getValue">): string {
  synchronizeVisualTexSnippetMirrors(field as object);
  synchronizeVisualTexMacroPromptArguments(field as object);
  const rawCompact = normalizeVisualTexLatex(field.getValue("latex-without-placeholders"));
  if (!rawCompact.includes(`\\${VISUAL_TEX_SOURCE_SPACE_MACRO_NAME}`)) {
    visualTexLastSourceSpaceBoundary.delete(field as object);
  }
  const compact = normalizeVisualTexMathLiveOutput(
    rawCompact,
  );
  const previous = visualTexMathfieldSerializationStates.get(field as object);
  if (!previous) return compact;

  const expanded = normalizeVisualTexMathLiveOutput(
    stripVisualTexPlaceholders(normalizeVisualTexLatex(field.getValue("latex-expanded"))),
  );
  const resolved = resolveVisualTexMathfieldSerialization(previous, compact, expanded);
  visualTexMathfieldSerializationStates.set(field as object, resolved.state);
  return resolved.value;
}

/**
 * Return a prompt-preserving source string suitable for reparsing MathLive's
 * atom tree. The same compact-vs-expanded decision used for note writeback is
 * essential here: reparsing stale compact macro arguments would silently undo
 * an earlier edit made inside an existing custom macro.
 */
function visualTexMathfieldReparseSource(field: Pick<MathfieldElement, "getValue">): string {
  synchronizeVisualTexSnippetMirrors(field as object);
  synchronizeVisualTexMacroPromptArguments(field as object);
  const rawCompact = normalizeVisualTexLatex(field.getValue("latex"));
  const rawExpanded = normalizeVisualTexLatex(field.getValue("latex-expanded"));
  const compact = normalizeVisualTexMathLiveOutput(
    normalizeVisualTexLatex(field.getValue("latex-without-placeholders")),
  );
  const expanded = normalizeVisualTexMathLiveOutput(
    stripVisualTexPlaceholders(rawExpanded),
  );
  const resolved = resolveVisualTexMathfieldSerialization(
    visualTexMathfieldSerializationStates.get(field as object) ?? null,
    compact,
    expanded,
  );
  visualTexMathfieldSerializationStates.set(field as object, resolved.state);
  return resolved.state.expandedWriteback ? rawExpanded : rawCompact;
}

export function syncVisualTexMathfieldDraft(
  field: Pick<MathfieldElement, "getValue">,
  onInput: (latex: string) => void,
): string {
  const draft = visualTexMathfieldLatex(field);
  onInput(draft);
  return draft;
}

function visualTexMathfieldRangeLatex(
  field: MathfieldElement,
  from: number,
  to: number,
): string {
  // A custom MacroAtom keeps its invocation arguments as an immutable source
  // string. Its expanded body is the only range representation that follows
  // edits made inside the macro, so completion/caret operations must read the
  // live tree rather than those cached arguments.
  return stripVisualTexPlaceholders(
    normalizeVisualTexMathLiveOutput(
      normalizeVisualTexLatex(field.getValue(from, to, "latex-expanded")),
    ),
  );
}

export type VisualTexMathLiveMacro = {
  def: string;
  args: number;
  captureSelection: false;
  expand: boolean;
};

export type VisualTexMathfieldSerializationState = {
  compact: string;
  expanded: string;
  expandedWriteback: boolean;
};

const visualTexMathfieldSerializationStates = new WeakMap<object, VisualTexMathfieldSerializationState>();
// MathLive intentionally drops ordinary math whitespace. Keep an explicit
// Space boundary in its transient atom model as a reserved empty macro; the
// serializer below turns this editor-only atom back into one ordinary source
// space before any draft reaches the note. `expand: false` keeps the atom in
// both compact and expanded range serialization, including around user macros.
const VISUAL_TEX_SOURCE_SPACE_MACRO_NAME = "noemaMathSpaceBoundary";
const VISUAL_TEX_SOURCE_SPACE_MARKER = String.raw`\noemaMathSpaceBoundary `;
const VISUAL_TEX_SOURCE_SPACE_MARKER_RE =
  /(?:[ \t]*\\noemaMathSpaceBoundary(?![A-Za-z])[ \t]*)+/g;
const VISUAL_TEX_CARET_MARKER_MACRO_NAME = "noemaMathCaretBoundary";
const VISUAL_TEX_CARET_MARKER = String.raw`\noemaMathCaretBoundary{}`;
const VISUAL_TEX_CARET_MARKER_RE = /\\noemaMathCaretBoundary(?![A-Za-z])(?:\{\})?[ \t]*/g;
const VISUAL_TEX_SOURCE_SPACE_MACRO: VisualTexMathLiveMacro = {
  def: "",
  args: 0,
  captureSelection: false,
  expand: false,
};
const VISUAL_TEX_CARET_MARKER_MACRO: VisualTexMathLiveMacro = {
  def: "",
  args: 1,
  captureSelection: false,
  expand: false,
};
const visualTexLastSourceSpaceBoundary = new WeakMap<object, number>();

type VisualTexSnippetPromptSession = {
  groups: VisualTexCompletionTemplate["tabstops"];
  /** MathLive offset immediately after the inserted snippet (`$0`). */
  finalPosition: number;
  /** Root size when the anchor was recorded; prompt edits map it by this delta. */
  lastOffset: number;
};
type VisualTexPromptField = Pick<
  MathfieldElement,
  | "position"
  | "lastOffset"
  | "selection"
  | "getPrompts"
  | "getPromptRange"
  | "getPromptValue"
  | "setPromptValue"
>;

const visualTexSnippetPromptSessions = new WeakMap<object, VisualTexSnippetPromptSession[]>();
const visualTexSnippetMirrorSync = new WeakSet<object>();
const visualTexNoemaPromptIds = new WeakMap<object, Set<string>>();
const visualTexCompletedPromptIds = new WeakMap<object, Set<string>>();
const visualTexCompletedPromptGroups = new WeakMap<
  object,
  VisualTexSnippetPromptSession["groups"]
>();
const visualTexMacroArgumentTemplates = new WeakMap<object, string>();
const visualTexUndoSanitizers = new WeakSet<object>();
const visualTexUndoPromptSanitizing = new WeakSet<object>();
const visualTexHistoryRecordingSuspended = new WeakSet<object>();

type VisualTexUndoController = {
  undoManager?: { recording?: boolean };
  stopRecording?: () => void;
  startRecording?: () => void;
  stopCoalescingUndo?: () => void;
  snapshot?: (operation?: string) => void;
};

function withVisualTexUndoRecordingSuspended<T>(field: object, action: () => T): T {
  const controller = (field as { _mathfield?: VisualTexUndoController })._mathfield;
  const wasRecording = controller?.undoManager?.recording !== false;
  if (!controller?.stopRecording || !controller.startRecording || !wasRecording) return action();
  controller.stopRecording();
  try {
    return action();
  } finally {
    controller.startRecording();
  }
}

function stopVisualTexUndoCoalescing(field: object): void {
  (field as { _mathfield?: VisualTexUndoController })
    ._mathfield?.stopCoalescingUndo?.();
}

function snapshotVisualTexUndoState(field: object, operation: string): void {
  (field as { _mathfield?: VisualTexUndoController })
    ._mathfield?.snapshot?.(operation);
}

function rememberCompletedVisualTexPrompts(
  field: object,
  groups: VisualTexSnippetPromptSession["groups"],
): void {
  const completedGroups = visualTexCompletedPromptGroups.get(field) ?? [];
  completedGroups.push(...groups.map((group) => ({
    ...group,
    promptIds: [...group.promptIds],
  })));
  // MathLive retains at most 1,000 undo states. This comfortably covers that
  // history even for snippets with several mirrored tabstops, while keeping a
  // long-lived editor from accumulating an unbounded registry.
  let promptCount = completedGroups.reduce((count, group) => count + group.promptIds.length, 0);
  while (promptCount > 4096 && completedGroups.length > 0) {
    promptCount -= completedGroups.shift()!.promptIds.length;
  }
  const completed = new Set(completedGroups.flatMap((group) => group.promptIds));
  visualTexCompletedPromptGroups.set(field, completedGroups);
  visualTexCompletedPromptIds.set(field, completed);
}

function visualTexPromptField(field: object): VisualTexPromptField | null {
  const candidate = field as Partial<VisualTexPromptField>;
  return typeof candidate.getPrompts === "function"
    && typeof candidate.getPromptRange === "function"
    && typeof candidate.getPromptValue === "function"
    && typeof candidate.setPromptValue === "function"
    ? candidate as VisualTexPromptField
    : null;
}

function registerVisualTexSnippetPrompts(
  field: MathfieldElement,
  tabstops: VisualTexCompletionTemplate["tabstops"],
): void {
  if (tabstops.length === 0) return;
  const sessions = visualTexSnippetPromptSessions.get(field) ?? [];
  sessions.push({
    groups: tabstops.map((group) => ({
      ...group,
      promptIds: [...group.promptIds],
    })),
    finalPosition: field.position,
    lastOffset: field.lastOffset,
  });
  visualTexSnippetPromptSessions.set(field, sessions.slice(-32));
}

type VisualTexActivePrompt = {
  session: VisualTexSnippetPromptSession;
  groupIndex: number;
  promptId: string;
  range: [number, number];
};

function activeVisualTexSnippetPrompt(field: object): VisualTexActivePrompt | null {
  const promptField = visualTexPromptField(field);
  const sessions = visualTexSnippetPromptSessions.get(field);
  if (!promptField || !sessions?.length) return null;
  const available = new Set(promptField.getPrompts());
  const selection = promptField.selection.ranges[0];
  if (!selection) return null;
  const selectedFrom = Math.min(selection[0], selection[1]);
  const selectedTo = Math.max(selection[0], selection[1]);
  const candidates: VisualTexActivePrompt[] = [];
  for (const session of [...sessions].reverse()) {
    for (let groupIndex = 0; groupIndex < session.groups.length; groupIndex++) {
      const group = session.groups[groupIndex]!;
      for (const promptId of group.promptIds) {
        if (!available.has(promptId)) continue;
        const range = promptField.getPromptRange(promptId);
        if (!range) continue;
        const from = Math.min(range[0], range[1]);
        const to = Math.max(range[0], range[1]);
        const exact = selectedFrom === from && selectedTo === to;
        const containsCaret = selectedFrom === selectedTo
          && promptField.position >= from
          && promptField.position <= to;
        if (exact || containsCaret) {
          candidates.push({ session, groupIndex, promptId, range: [from, to] });
        }
      }
    }
    if (candidates.length > 0) break;
  }
  return candidates.sort((a, b) => {
    const aExact = a.range[0] === selectedFrom && a.range[1] === selectedTo ? 0 : 1;
    const bExact = b.range[0] === selectedFrom && b.range[1] === selectedTo ? 0 : 1;
    return aExact - bExact || (a.range[1] - a.range[0]) - (b.range[1] - b.range[0]);
  })[0] ?? null;
}

function selectVisualTexPrompt(field: object, id: string): boolean {
  const promptField = visualTexPromptField(field);
  if (!promptField || !promptField.getPrompts().includes(id)) return false;
  const range = promptField.getPromptRange(id);
  if (!range) return false;
  const promptMode = (field as {
    _mathfield?: { getPrompt?: (promptId: string) => { mode?: MathfieldElement["mode"] } | undefined };
  })._mathfield?.getPrompt?.(id)?.mode;
  withVisualTexUndoRecordingSuspended(field, () => {
    promptField.selection = { ranges: [[range[0], range[1]]], direction: "forward" };
    // A non-collapsed prompt selection does not reliably make MathLive switch
    // its model mode. Without this, a text prompt followed by math receives
    // `$ x $` instead of a real text `x` even though it is visibly inside
    // `\\text{...}`.
    const modeField = field as Partial<Pick<MathfieldElement, "mode">>;
    if (promptMode && modeField.mode !== promptMode) modeField.mode = promptMode;
  });
  // Assigning MathfieldElement.selection directly does not call MathLive's
  // command-layer coalescing barrier. A structural tabstop move should split
  // the surrounding typing into distinct, predictable undo steps.
  stopVisualTexUndoCoalescing(field);
  return true;
}

function joinVisualTexLexicalBoundary(left: string, right: string): string {
  if (!/^[A-Za-z]/.test(right)) return left + right;
  const controlWord = left.match(/\\[A-Za-z]+$/);
  if (!controlWord) return left + right;
  const slash = left.length - controlWord[0].length;
  // A doubled backslash is a control symbol/row separator, not the start of a
  // control word. Only a real TeX control word needs a lexical delimiter
  // before an alphabetic prompt value.
  return isEscaped(left, slash) ? left + right : `${left} ${right}`;
}

function unwrapVisualTexPromptIds(source: string, promptIds: ReadonlySet<string>): string {
  let result = "";
  for (let index = 0; index < source.length;) {
    if (source.startsWith("\\placeholder", index)
      && !/[A-Za-z]/.test(source[index + "\\placeholder".length] ?? "")) {
      let cursor = index + "\\placeholder".length;
      const options: Array<{ body: string; end: number }> = [];
      while (source[cursor] === "[") {
        const option = readDelimitedGroup(source, cursor, "[", "]");
        if (!option) break;
        options.push(option);
        cursor = option.end;
      }
      const body = readDelimitedGroup(source, cursor, "{", "}");
      if (body) {
        const content = unwrapVisualTexPromptIds(body.body, promptIds);
        if (promptIds.has(options[0]?.body ?? "")) {
          result = joinVisualTexLexicalBoundary(result, content);
        } else {
          result += `${source.slice(index, cursor + 1)}${content}}`;
        }
        index = body.end;
        continue;
      }
    }
    result += source[index]!;
    index++;
  }
  return result;
}

function finishVisualTexSnippetPromptSession(
  field: VisualTexPromptField,
  session: VisualTexSnippetPromptSession,
  mappedFinal: number,
): number {
  const sessions = visualTexSnippetPromptSessions.get(field as object) ?? [];
  const live = field as VisualTexPromptField & Partial<Pick<
    MathfieldElement,
    "getValue" | "setValue" | "insert"
  >>;

  // A completed Noema session must stop being a MathLive prompt provider.
  // Keeping those atoms alive makes the native placeholder command wrap back
  // to the first field (the apparent Cmd-] jump to line/formula start) and
  // leaves an empty prompt box where users expect the invisible `$0` caret.
  synchronizeVisualTexSnippetMirrors(field as object);
  synchronizeVisualTexMacroPromptArguments(field as object);
  const completedIds = new Set(session.groups.flatMap((group) => group.promptIds));
  visualTexSnippetPromptSessions.set(
    field as object,
    sessions.filter((candidate) => candidate !== session),
  );
  if (typeof live.getValue !== "function"
      || (typeof live.insert !== "function" && typeof live.setValue !== "function")) return mappedFinal;
  const source = visualTexMathfieldReparseSource(live as MathfieldElement);
  const flattened = unwrapVisualTexPromptIds(source, completedIds).replace(
    VISUAL_TEX_SOURCE_SPACE_MARKER_RE,
    VISUAL_TEX_SOURCE_SPACE_MARKER,
  );
  const distanceFromEnd = Math.max(0, field.lastOffset - mappedFinal);
  const stillMounted = field.getPrompts().some((id) => completedIds.has(id));
  if (flattened !== source || stillMounted) {
    // MathfieldElement.setValue() intentionally short-circuits when its
    // placeholder-free serialization equals VALUE, even if prompt atoms are
    // still mounted. replaceAll forces a fresh parse. Empty boundary macros
    // sit outside MathLive's replaceable range, so detach their old atoms
    // first and let the flattened source recreate each boundary exactly once.
    reparseVisualTexMathfield(field as object, live, flattened, completedIds);
  }
  rememberCompletedVisualTexPrompts(field as object, session.groups);
  const registeredIds = visualTexNoemaPromptIds.get(field as object);
  if (registeredIds) {
    for (const id of completedIds) registeredIds.delete(id);
  }
  return Math.max(0, Math.min(field.lastOffset - distanceFromEnd, field.lastOffset));
}

/**
 * A mouse click or ordinary arrow can leave every registered prompt without
 * traversing Noema's explicit tabstop command. Flatten those abandoned prompt
 * wrappers before the next structural action; otherwise their visible boxes
 * survive while Cmd-] treats the formula as already being at its root edge.
 */
function finishInactiveVisualTexSnippetPromptSessions(field: object): boolean {
  if (activeVisualTexSnippetPrompt(field)) return false;
  const promptField = visualTexPromptField(field);
  const sessions = visualTexSnippetPromptSessions.get(field);
  const selection = promptField?.selection.ranges[0];
  if (!promptField || !sessions?.length || !selection
      || promptField.selection.ranges.length !== 1 || selection[0] !== selection[1]) return false;

  let mappedPosition = promptField.position;
  for (const session of [...sessions].reverse()) {
    mappedPosition = finishVisualTexSnippetPromptSession(
      promptField,
      session,
      mappedPosition,
    );
  }
  withVisualTexUndoRecordingSuspended(field, () => {
    promptField.selection = {
      ranges: [[mappedPosition, mappedPosition]],
      direction: "forward",
    };
  });
  stopVisualTexUndoCoalescing(field);
  return true;
}

function finishAllVisualTexSnippetPromptSessions(field: object): boolean {
  const promptField = visualTexPromptField(field);
  const sessions = visualTexSnippetPromptSessions.get(field);
  if (!promptField || !sessions?.length) return false;
  let mappedPosition = promptField.position;
  for (const session of [...sessions].reverse()) {
    mappedPosition = finishVisualTexSnippetPromptSession(promptField, session, mappedPosition);
  }
  withVisualTexUndoRecordingSuspended(field, () => {
    promptField.selection = {
      ranges: [[mappedPosition, mappedPosition]],
      direction: "forward",
    };
  });
  stopVisualTexUndoCoalescing(field);
  return true;
}

export function selectAllVisualTexMathfield(field: MathfieldElement): void {
  // Selecting the whole formula explicitly leaves snippet-entry mode. Keeping
  // prompt wrappers mounted here makes the selection contain editor scaffolding
  // and can resurrect its tab cycle after the selection is replaced.
  finishAllVisualTexSnippetPromptSessions(field);
  withVisualTexUndoRecordingSuspended(field, () => {
    field.executeCommand("selectAll");
  });
}

function moveVisualTexSnippetPrompt(
  field: object,
  backward: boolean,
): "moved" | "final" | "exhausted" | "none" {
  const active = activeVisualTexSnippetPrompt(field);
  if (!active) return "none";
  const step = backward ? -1 : 1;
  for (let index = active.groupIndex + step;
    index >= 0 && index < active.session.groups.length;
    index += step) {
    if (selectVisualTexPrompt(field, active.session.groups[index]!.primaryId)) return "moved";
  }
  if (!backward) {
    const promptField = visualTexPromptField(field);
    if (!promptField) return "exhausted";
    const mappedFinal = Math.max(0, Math.min(
      active.session.finalPosition + (promptField.lastOffset - active.session.lastOffset),
      promptField.lastOffset,
    ));
    const finalPosition = finishVisualTexSnippetPromptSession(
      promptField,
      active.session,
      mappedFinal,
    );
    withVisualTexUndoRecordingSuspended(field, () => {
      promptField.selection = { ranges: [[finalPosition, finalPosition]], direction: "forward" };
    });
    stopVisualTexUndoCoalescing(field);
    return "final";
  }
  return "exhausted";
}

function synchronizeVisualTexSnippetMirrors(field: object): void {
  const promptField = visualTexPromptField(field);
  const active = activeVisualTexSnippetPrompt(field);
  if (!promptField || !active || visualTexSnippetMirrorSync.has(field)) return;
  const group = active.session.groups[active.groupIndex]!;
  if (group.promptIds.length < 2) return;
  const value = promptField.getPromptValue(active.promptId, "latex-without-placeholders");
  const savedSelection = {
    ranges: promptField.selection.ranges.map(([from, to]) => [from, to] as [number, number]),
    direction: promptField.selection.direction,
  };
  visualTexSnippetMirrorSync.add(field);
  try {
    // Mirrors are one logical user edit. Updating their auxiliary PromptAtoms
    // must not add extra undo entries or make the first Cmd-Z appear to change
    // only an invisible duplicate field.
    withVisualTexUndoRecordingSuspended(field, () => {
      for (const id of group.promptIds) {
        if (id === active.promptId || !promptField.getPrompts().includes(id)) continue;
        if (promptField.getPromptValue(id, "latex-without-placeholders") === value) continue;
        promptField.setPromptValue(id, value, {
          format: "latex",
          selectionMode: "after",
          focus: false,
          feedback: false,
          silenceNotifications: true,
        });
      }
    });
    withVisualTexUndoRecordingSuspended(field, () => {
      promptField.selection = savedSelection;
    });
  } finally {
    visualTexSnippetMirrorSync.delete(field);
  }
}

function readDelimitedGroup(
  source: string,
  from: number,
  open: string,
  close: string,
): { body: string; end: number } | null {
  if (source[from] !== open) return null;
  let depth = 0;
  for (let index = from; index < source.length; index++) {
    const character = source[index]!;
    if (character === open && !isEscaped(source, index)) depth++;
    else if (character === close && !isEscaped(source, index)) {
      depth--;
      if (depth === 0) return { body: source.slice(from + 1, index), end: index + 1 };
    }
  }
  return null;
}

type VisualTexInternalMacroAtom = {
  type?: string;
  command?: string;
  macroArgs?: string;
  placeholderId?: string;
  parent?: VisualTexInternalMacroAtom;
  parentBranch?: string | [number, number];
  isDirty?: boolean;
  branches?: string[];
  branch?: (name: string) => VisualTexInternalMacroAtom[] | undefined;
};

function detachVisualTexMacroAtoms(field: object, macroName: string): number {
  const root = (field as {
    _mathfield?: { model?: { root?: VisualTexInternalMacroAtom } };
  })._mathfield?.model?.root;
  if (!root) return 0;
  let removed = 0;
  const visit = (atom: VisualTexInternalMacroAtom): void => {
    for (const branch of atom.branches ?? []) {
      const children = atom.branch?.(branch);
      if (!children) continue;
      for (let index = children.length - 1; index >= 0; index--) {
        const child = children[index]!;
        if (child.type === "macro"
            && child.command === `\\${macroName}`) {
          children.splice(index, 1);
          removed++;
        } else {
          visit(child);
        }
      }
    }
  };
  visit(root);
  return removed;
}

function detachVisualTexSourceSpaceAtoms(field: object): number {
  return detachVisualTexMacroAtoms(field, VISUAL_TEX_SOURCE_SPACE_MACRO_NAME);
}

function detachVisualTexCaretMarkerAtoms(field: object): number {
  return detachVisualTexMacroAtoms(field, VISUAL_TEX_CARET_MARKER_MACRO_NAME);
}

/**
 * MathLive compares replacement TeX after stripping placeholders. For an
 * empty prompt (notably `\\text{\\placeholder{}}`) that makes replaceAll a
 * semantic no-op and leaves the visible PromptAtom mounted. Unwrap only the
 * completed Noema prompts in the live tree when that happens; this preserves
 * the current undo snapshot instead of reparsing through setValue().
 */
function unwrapMountedVisualTexPromptAtoms(
  field: object,
  promptIds: ReadonlySet<string>,
): number {
  const root = (field as {
    _mathfield?: { model?: { root?: VisualTexInternalMacroAtom } };
  })._mathfield?.model?.root;
  if (!root || promptIds.size === 0) return 0;

  let unwrapped = 0;
  const visit = (parent: VisualTexInternalMacroAtom): void => {
    for (const branchName of parent.branches ?? []) {
      const children = parent.branch?.(branchName);
      if (!children) continue;
      for (let index = children.length - 1; index >= 0; index--) {
        const child = children[index]!;
        visit(child);
        if (child.type !== "prompt"
            || !child.placeholderId
            || !promptIds.has(child.placeholderId)) continue;

        const body = child.branch?.("body") ?? [];
        const moved = body.splice(0).filter((atom) => atom.type !== "first");
        children.splice(index, 1, ...moved);
        for (const atom of moved) {
          atom.parent = parent;
          atom.parentBranch = branchName;
        }
        child.parent = undefined;
        child.parentBranch = undefined;
        child.isDirty = true;
        parent.isDirty = true;
        unwrapped++;
      }
    }
  };
  visit(root);
  return unwrapped;
}

function reparseVisualTexMathfield(
  field: object,
  live: Partial<Pick<MathfieldElement, "getValue" | "setValue" | "insert">>,
  source: string,
  promptIds?: ReadonlySet<string>,
): void {
  const model = (field as { _mathfield?: { model?: { mode?: string } } })._mathfield?.model;
  const previousMode = model?.mode;
  const insertOptions = {
    format: "latex" as const,
    mode: "math" as const,
    insertionMode: "replaceAll" as const,
    selectionMode: "after" as const,
    focus: false,
    feedback: false,
    scrollIntoView: false,
    silenceNotifications: true,
  };
  const setValueOptions = {
    format: "latex" as const,
    mode: "math" as const,
    insertionMode: "replaceAll" as const,
    selectionMode: "after" as const,
    focus: false,
    silenceNotifications: true,
  };
  const resetSelectionBeforeDetach = (): void => {
    const target = field as Partial<Pick<MathfieldElement, "position">>;
    if (typeof target.position === "number") target.position = 0;
  };

  // Prompt wrappers and caret/source markers are editor scaffolding, not user
  // edits. `insert(..., replaceAll)` respects a suspended undo manager; unlike
  // setValue(), it does not reset MathLive's undo/redo history.
  withVisualTexUndoRecordingSuspended(field, () => {
    resetSelectionBeforeDetach();
    // Empty macros can sit outside MathLive's replaceable model range. Remove
    // their old atoms first so the requested source recreates each one once.
    detachVisualTexSourceSpaceAtoms(field);
    detachVisualTexCaretMarkerAtoms(field);
    if (typeof live.insert === "function") live.insert(source, insertOptions);
    else live.setValue?.(source, setValueOptions);
    if (promptIds) unwrapMountedVisualTexPromptAtoms(field, promptIds);
    // Whole-field LaTeX must be parsed in math mode, but the editing mode is
    // caret state. Preserve it so setting the mapped caret does not make
    // MathLive record a mode-only undo step (especially after `\\text{...}`).
    if (model && previousMode) model.mode = previousMode;
  });
  if (typeof live.getValue === "function") {
    primeVisualTexMathfieldSerialization(live as Pick<MathfieldElement, "getValue">);
  }
}

function visualTexMacroAtomOffset(field: object, command: string): number | null {
  const model = (field as {
    _mathfield?: {
      model?: {
        root?: VisualTexInternalMacroAtom;
        offsetOf?: (atom: VisualTexInternalMacroAtom) => number;
      };
    };
  })._mathfield?.model;
  if (!model?.root || typeof model.offsetOf !== "function") return null;
  let result: number | null = null;
  const visit = (atom: VisualTexInternalMacroAtom): void => {
    if (result !== null) return;
    if (atom.type === "macro" && atom.command === command) {
      const offset = model.offsetOf!(atom);
      if (Number.isFinite(offset)) result = offset;
      return;
    }
    for (const branch of atom.branches ?? []) {
      for (const child of atom.branch?.(branch) ?? []) visit(child);
    }
  };
  visit(model.root);
  return result;
}

function resolveVisualTexPromptArgumentTemplate(
  source: string,
  field: VisualTexPromptField,
  available: ReadonlySet<string>,
): string {
  let result = "";
  for (let index = 0; index < source.length;) {
    if (!source.startsWith("\\placeholder", index)
      || /[A-Za-z]/.test(source[index + "\\placeholder".length] ?? "")) {
      result += source[index]!;
      index++;
      continue;
    }

    let cursor = index + "\\placeholder".length;
    const options: string[] = [];
    while (source[cursor] === "[") {
      const option = readDelimitedGroup(source, cursor, "[", "]");
      if (!option) break;
      options.push(option.body);
      cursor = option.end;
    }
    const body = readDelimitedGroup(source, cursor, "{", "}");
    if (!body) {
      result += source[index]!;
      index++;
      continue;
    }

    const id = options[0] ?? "";
    result += id && available.has(id)
      ? field.getPromptValue(id, "latex-without-placeholders")
      : resolveVisualTexPromptArgumentTemplate(body.body, field, available);
    index = body.end;
  }
  return result;
}

/**
 * MathLive keeps a MacroAtom's original argument source immutable even while
 * its rendered prompt body changes. Noema snippets carry stable prompt IDs, so
 * refresh that private source string from the live prompt values before asking
 * MathLive for compact TeX. This keeps `\\bra{...}`/`\\braket{...}` intact and
 * avoids falling back to a `\\left...\\middle...` expansion on save.
 */
function synchronizeVisualTexMacroPromptArguments(field: object): void {
  const promptField = visualTexPromptField(field);
  const root = (field as {
    _mathfield?: { model?: { root?: VisualTexInternalMacroAtom } };
  })._mathfield?.model?.root;
  const noemaIds = new Set([
    ...(visualTexNoemaPromptIds.get(field) ?? []),
    ...(visualTexCompletedPromptIds.get(field) ?? []),
  ]);
  if (!promptField || !root || !noemaIds.size) return;
  const available = new Set(promptField.getPrompts());

  const visit = (atom: VisualTexInternalMacroAtom): void => {
    if (atom.type === "macro" && typeof atom.macroArgs === "string") {
      let template = visualTexMacroArgumentTemplates.get(atom);
      if (!template && atom.macroArgs.includes("\\placeholder")
        && [...noemaIds].some((id) => atom.macroArgs!.includes(`[${id}]`))) {
        template = atom.macroArgs;
        visualTexMacroArgumentTemplates.set(atom, template);
      }
      if (template) {
        atom.macroArgs = resolveVisualTexPromptArgumentTemplate(
          template,
          promptField,
          new Set([...available].filter((id) => noemaIds.has(id))),
        );
      }
    }
    for (const branch of atom.branches ?? []) {
      for (const child of atom.branch?.(branch) ?? []) visit(child);
    }
  };
  visit(root);
}

function synchronizeRestoredVisualTexPromptMirrors(
  field: object,
  restored: ReadonlySet<string>,
): void {
  const promptField = visualTexPromptField(field);
  const groups = visualTexCompletedPromptGroups.get(field);
  if (!promptField || !groups?.length) return;
  const savedSelection = {
    ranges: promptField.selection.ranges.map(([from, to]) => [from, to] as [number, number]),
    direction: promptField.selection.direction,
  };
  withVisualTexUndoRecordingSuspended(field, () => {
    for (const group of groups) {
      const available = group.promptIds.filter((id) => restored.has(id));
      if (available.length < 2) continue;
      const sourceId = available.includes(group.primaryId) ? group.primaryId : available[0]!;
      const value = promptField.getPromptValue(sourceId, "latex-without-placeholders");
      for (const id of available) {
        if (id === sourceId
            || promptField.getPromptValue(id, "latex-without-placeholders") === value) continue;
        promptField.setPromptValue(id, value, {
          format: "latex",
          selectionMode: "after",
          focus: false,
          feedback: false,
          silenceNotifications: true,
        });
      }
    }
  });
  withVisualTexUndoRecordingSuspended(field, () => {
    promptField.selection = savedSelection;
  });
}

/**
 * Undo states captured while a snippet was active contain MathLive PromptAtom
 * wrappers. Once that snippet has completed, undo/redo may restore its value
 * but must never restore its editor-only boxes or tab cycle.
 */
function flattenRestoredVisualTexPromptAtoms(
  field: object,
  historyType?: "undo" | "redo",
): boolean {
  if (visualTexUndoPromptSanitizing.has(field)) return false;
  const promptField = visualTexPromptField(field);
  const completed = visualTexCompletedPromptIds.get(field);
  const live = field as Partial<Pick<MathfieldElement, "getValue" | "setValue" | "insert">>;
  if (!promptField || !completed?.size || typeof live.getValue !== "function"
      || (typeof live.insert !== "function" && typeof live.setValue !== "function")) return false;
  const restored = new Set(promptField.getPrompts().filter((id) => completed.has(id)));
  if (restored.size === 0) return false;

  visualTexUndoPromptSanitizing.add(field);
  try {
    synchronizeRestoredVisualTexPromptMirrors(field, restored);
    synchronizeVisualTexMacroPromptArguments(field);
    const selection = promptField.selection.ranges[0];
    const distanceFromEnd = Math.max(0, promptField.lastOffset - promptField.position);
    let caretMarkerInserted = false;
    if (selection && promptField.selection.ranges.length === 1
        && selection[0] === selection[1]
        && (field as Partial<Pick<MathfieldElement, "mode">>).mode !== "text"
        && typeof live.insert === "function") {
      caretMarkerInserted = withVisualTexUndoRecordingSuspended(field, () => live.insert!(
        VISUAL_TEX_CARET_MARKER,
        {
          format: "latex",
          mode: "math",
          insertionMode: "insertAfter",
          selectionMode: "after",
          focus: false,
          feedback: false,
          scrollIntoView: false,
          silenceNotifications: true,
        },
      ));
    }
    const source = visualTexMathfieldReparseSource(live as MathfieldElement);
    const flattened = unwrapVisualTexPromptIds(source, restored).replace(
      VISUAL_TEX_SOURCE_SPACE_MARKER_RE,
      VISUAL_TEX_SOURCE_SPACE_MARKER,
    );
    reparseVisualTexMathfield(field, live, flattened, restored);
    let position = Math.max(0, Math.min(
      promptField.lastOffset - distanceFromEnd,
      promptField.lastOffset,
    ));
    const caretOffset = caretMarkerInserted
      ? visualTexMacroAtomOffset(field, `\\${VISUAL_TEX_CARET_MARKER_MACRO_NAME}`)
      : null;
    if (caretOffset !== null && typeof live.insert === "function") {
      const markerFree = visualTexMathfieldReparseSource(live as MathfieldElement)
        .replace(VISUAL_TEX_CARET_MARKER_RE, "");
      reparseVisualTexMathfield(field, live, markerFree);
      position = Math.max(0, Math.min(caretOffset - 1, promptField.lastOffset));
    }
    // Restoring a caret can cross text/math mode. MathLive snapshots that mode
    // switch even when no content changes, which would consume redo with an
    // invisible step. Caret restoration is part of sanitizing the history
    // state, so keep it outside the user's undo timeline too.
    withVisualTexUndoRecordingSuspended(field, () => {
      promptField.selection = { ranges: [[position, position]], direction: "forward" };
    });
    stopVisualTexUndoCoalescing(field);
    if (historyType && typeof (field as Partial<EventTarget>).dispatchEvent === "function") {
      // MathLive emitted its history input before the undo-state-change event,
      // while restored mirror prompts could still disagree. Publish the final,
      // sanitized value so previews and host drafts observe the same state that
      // will be committed.
      (field as EventTarget).dispatchEvent(new InputEvent("input", {
        bubbles: true,
        composed: true,
        inputType: historyType === "undo" ? "historyUndo" : "historyRedo",
      }));
    }
    return true;
  } finally {
    visualTexUndoPromptSanitizing.delete(field);
  }
}

function installVisualTexUndoSanitizer(field: object): void {
  if (visualTexUndoSanitizers.has(field)) return;
  const target = field as Partial<Pick<HTMLElement, "addEventListener">>;
  if (typeof target.addEventListener !== "function") return;
  target.addEventListener("beforeinput", ((event: InputEvent) => {
    if (event.inputType !== "historyUndo" && event.inputType !== "historyRedo") return;
    const controller = (field as { _mathfield?: VisualTexUndoController })._mathfield;
    if (!controller?.stopRecording || controller.undoManager?.recording === false) return;
    // MathLive restores both content and selection, then may call switchMode()
    // for the restored caret. switchMode snapshots directly, which otherwise
    // truncates redo with a mode-only state before `undo-state-change` fires.
    controller.stopRecording();
    visualTexHistoryRecordingSuspended.add(field);
  }) as EventListener, { capture: true });
  target.addEventListener("undo-state-change", ((event: CustomEvent<{ type?: string }>) => {
    if (event.detail?.type === "undo" || event.detail?.type === "redo") {
      try {
        flattenRestoredVisualTexPromptAtoms(field, event.detail.type);
      } finally {
        if (visualTexHistoryRecordingSuspended.delete(field)) {
          (field as { _mathfield?: VisualTexUndoController })._mathfield?.startRecording?.();
        }
      }
    }
  }) as EventListener);
  visualTexUndoSanitizers.add(field);
}

/** Remove both MathLive prompt commands and its insertion-only `#?` marker. */
export function stripVisualTexPlaceholders(source: string): string {
  let result = "";
  for (let index = 0; index < source.length;) {
    if (source[index] === "#" && source[index + 1] === "?" && !isEscaped(source, index)) {
      index += 2;
      continue;
    }
    if (source.startsWith("\\placeholder", index)
      && !/[A-Za-z]/.test(source[index + "\\placeholder".length] ?? "")) {
      let cursor = index + "\\placeholder".length;
      while (source[cursor] === "[") {
        const option = readDelimitedGroup(source, cursor, "[", "]");
        if (!option) break;
        cursor = option.end;
      }
      const body = readDelimitedGroup(source, cursor, "{", "}");
      if (body) {
        result += stripVisualTexPlaceholders(body.body);
        index = body.end;
        continue;
      }
    }
    result += source[index]!;
    index++;
  }
  return result;
}

/**
 * MathLive's expanded/placeholder-free serializer wraps `\\middle` delimiters
 * in an ordinary group (`\\middle{|}`). TeX and KaTeX require a delimiter
 * token (`\\middle|`), so repair that serializer boundary before any draft is
 * compared or written back.
 */
export function normalizeVisualTexMathLiveOutput(source: string): string {
  return source
    .replace(VISUAL_TEX_CARET_MARKER_RE, "")
    .replace(VISUAL_TEX_SOURCE_SPACE_MARKER_RE, " ")
    .replace(/\\middle\s*\{([^{}\s]+)\}/g, (_whole, delimiter: string) => (
      `\\middle${delimiter}`
    ));
}

/**
 * MathLive deliberately serializes an editable MacroAtom as the original
 * command plus its original argument string. When a user changes the rendered
 * macro body, only `latex-expanded` contains those edits. Preserve compact
 * commands while they remain truthful; permanently switch this field to its
 * live expanded tree as soon as compact and expanded serialization diverge.
 */
export function resolveVisualTexMathfieldSerialization(
  previous: VisualTexMathfieldSerializationState | null,
  compact: string,
  expanded: string,
): { value: string; state: VisualTexMathfieldSerializationState } {
  const safeCompact = normalizeVisualTexMathLiveOutput(compact);
  const safeExpanded = normalizeVisualTexMathLiveOutput(stripVisualTexPlaceholders(expanded));
  const compactContainsInsertionState = stripVisualTexPlaceholders(safeCompact) !== safeCompact;
  const editedInsideMacro = previous !== null
    && safeCompact === previous.compact
    && safeExpanded !== previous.expanded;
  const expandedWriteback = Boolean(previous?.expandedWriteback)
    || compactContainsInsertionState
    || editedInsideMacro;
  const state = { compact: safeCompact, expanded: safeExpanded, expandedWriteback };
  return { value: expandedWriteback ? safeExpanded : safeCompact, state };
}

function primeVisualTexMathfieldSerialization(field: Pick<MathfieldElement, "getValue">): void {
  const previous = visualTexMathfieldSerializationStates.get(field as object);
  const compact = normalizeVisualTexMathLiveOutput(
    normalizeVisualTexLatex(field.getValue("latex-without-placeholders")),
  );
  const expanded = normalizeVisualTexMathLiveOutput(
    stripVisualTexPlaceholders(normalizeVisualTexLatex(field.getValue("latex-expanded"))),
  );
  visualTexMathfieldSerializationStates.set(field as object, {
    compact,
    expanded,
    expandedWriteback: Boolean(previous?.expandedWriteback)
      || stripVisualTexPlaceholders(compact) !== compact,
  });
}

/** Match MathLive's own string-macro arity inference for object definitions. */
export function visualTexMacroArgumentCount(expansion: string): number {
  let count = 0;
  for (let candidate = 1; candidate <= 9; candidate++) {
    if (new RegExp(`(^|[^\\\\])#${candidate}`).test(expansion)) count = candidate;
  }
  return count;
}

/**
 * KaTeX macro maps use command keys such as `\\R`; MathLive's MacroDictionary
 * uses the command name without the leading backslash. Keep one canonical
 * macro source and adapt only at the MathLive boundary.
 */
export function visualTexMathLiveMacros(
  macros: Record<string, string>,
): Record<string, VisualTexMathLiveMacro> {
  const result: Record<string, VisualTexMathLiveMacro> = {};
  for (const [command, expansion] of Object.entries(macros)) {
    const name = command.replace(/^\\+/, "");
    // Object macro definitions default to zero arguments: unlike string
    // definitions, MathLive does not infer #1..#9. Supplying the exact arity is
    // what keeps `\ket{sad}` from becoming `\ket` plus an external `{sad}`.
    // Expanded serialization must stay enabled because it is MathLive's only
    // truthful representation after editing inside the macro body.
    if (name) {
      result[name] = {
        def: expansion,
        args: visualTexMacroArgumentCount(expansion),
        captureSelection: false,
        expand: true,
      };
    }
  }
  return result;
}

type NoemaMathfieldInitializationTarget = Pick<MathfieldElement, "setValue" | "resetUndo"> & {
  macros: MathfieldElement["macros"];
};

/**
 * Install Noema's macro dictionary before parsing the note source. MathLive
 * does not reparse atoms when `macros` changes, so reversing this order turns
 * valid custom commands such as `\ket{a}` into an empty/error placeholder as
 * soon as LiveTeX opens.
 */
export function initializeNoemaMathfield(
  field: NoemaMathfieldInitializationTarget,
  latex: string,
  macros: Record<string, string>,
): void {
  visualTexLastSourceSpaceBoundary.delete(field as object);
  visualTexSnippetPromptSessions.delete(field as object);
  visualTexNoemaPromptIds.delete(field as object);
  visualTexCompletedPromptIds.delete(field as object);
  visualTexCompletedPromptGroups.delete(field as object);
  visualTexMathfieldSerializationStates.delete(field as object);
  installVisualTexUndoSanitizer(field as object);
  field.macros = {
    ...visualTexMathLiveMacros(macros),
    [VISUAL_TEX_SOURCE_SPACE_MACRO_NAME]: VISUAL_TEX_SOURCE_SPACE_MACRO,
    [VISUAL_TEX_CARET_MARKER_MACRO_NAME]: VISUAL_TEX_CARET_MARKER_MACRO,
  };
  field.setValue(normalizeVisualTexLatex(latex), { selectionMode: "after" });
  field.resetUndo();
  // resetUndo() removes MathLive's setValue snapshot as well as stale history.
  // Seed the clean parsed value again so the very first user edit can undo to
  // the note as opened instead of becoming an un-revertible index-zero state.
  snapshotVisualTexUndoState(field as object, "set-value");
  if (typeof (field as Partial<Pick<MathfieldElement, "getValue">>).getValue === "function") {
    primeVisualTexMathfieldSerialization(field as NoemaMathfieldInitializationTarget & Pick<MathfieldElement, "getValue">);
  }
}

export function visualTexCompletionPrefix(before: string): string {
  const source = normalizeVisualTexLatex(before).slice(-80);
  return source.match(/\\[A-Za-z]*$/)?.[0]
    ?? source.match(/@[A-Za-z0-9_%&()*+,./:;<=>[\]^_|-]*$/)?.[0]
    ?? source.match(/[:;][A-Za-z0-9_]*$/)?.[0]
    ?? source.match(/[A-Za-z][A-Za-z0-9_]*$/)?.[0]
    ?? source.match(/[!<>=+*/.|^~"-]+$/)?.[0]
    ?? "";
}

function completionPrefix(field: MathfieldElement): string {
  const before = visualTexMathfieldRangeLatex(field, 0, field.position);
  return visualTexCompletionPrefix(before);
}

function suffixRange(field: MathfieldElement, suffix: string): [number, number] | null {
  const to = field.position;
  if (!suffix) return [to, to];
  for (let from = to; from >= Math.max(0, to - suffix.length - 4); from--) {
    const latex = visualTexMathfieldRangeLatex(field, from, to);
    if (latex === suffix || latex.replace(/\s+/g, "") === suffix.replace(/\s+/g, "")) return [from, to];
  }
  return null;
}

export function applyVisualTexCompletionTemplate(
  field: MathfieldElement,
  prefix: string,
  template: string | VisualTexCompletionTemplate,
  deleteBefore: number,
): boolean {
  finishInactiveVisualTexSnippetPromptSessions(field);
  // MathLive keeps an unfinished backslash command in a transient editor.
  // Replacing that range directly reports success but leaves the completion
  // inside command mode, so neither Enter nor Space visibly accepts it.
  // Materialize the command as a normal math atom before replacing its range.
  if (field.mode === "latex") {
    withVisualTexUndoRecordingSuspended(field, () => {
      field.executeCommand(["complete", "accept-all"]);
    });
  }
  const suffix = prefix.slice(Math.max(0, prefix.length - deleteBefore));
  const range = suffixRange(field, suffix);
  if (!range) return false;
  withVisualTexUndoRecordingSuspended(field, () => {
    field.selection = { ranges: [range] };
  });
  const registeredPromptIds: string[] = [];
  if (typeof template !== "string") {
    const ids = visualTexNoemaPromptIds.get(field) ?? new Set<string>();
    for (const group of template.tabstops) {
      for (const id of group.promptIds) {
        ids.add(id);
        registeredPromptIds.push(id);
      }
    }
    visualTexNoemaPromptIds.set(field, ids);
  }
  let templateLatex = typeof template === "string" ? template : template.latex;
  if (typeof template !== "string" && template.needsFinalSourceBoundary) {
    templateLatex += VISUAL_TEX_SOURCE_SPACE_MARKER;
  }
  const inserted = field.insert(templateLatex, {
    format: "latex",
    insertionMode: "replaceSelection",
    selectionMode: typeof template === "string" ? "placeholder" : "after",
    focus: false,
    feedback: false,
    scrollIntoView: false,
  });
  if (!inserted) {
    const ids = visualTexNoemaPromptIds.get(field);
    for (const id of registeredPromptIds) ids?.delete(id);
    return false;
  }
  // Snippet expansion is one edit; text typed at its final caret is the next
  // edit even when both operations happen to create the same MathLive atom
  // type and would otherwise be coalesced.
  stopVisualTexUndoCoalescing(field);
  if (typeof template === "string") {
    focusVisualTexField(field);
    return true;
  }
  if (template.needsFinalSourceBoundary) {
    visualTexLastSourceSpaceBoundary.set(field, field.position);
  }
  registerVisualTexSnippetPrompts(field, template.tabstops);
  const first = [...template.tabstops].sort((a, b) => a.index - b.index)[0];
  if (first) selectVisualTexPrompt(field, first.primaryId);
  focusVisualTexField(field);
  return true;
}

function removeCompletionPrefix(field: MathfieldElement, prefix: string, deleteBefore: number): boolean {
  if (field.mode === "latex") {
    withVisualTexUndoRecordingSuspended(field, () => {
      field.executeCommand(["complete", "accept-all"]);
    });
  }
  const suffix = prefix.slice(Math.max(0, prefix.length - deleteBefore));
  const range = suffixRange(field, suffix);
  if (!range) return false;
  withVisualTexUndoRecordingSuspended(field, () => {
    field.selection = { ranges: [range] };
  });
  const inserted = field.insert("", {
    format: "latex",
    insertionMode: "replaceSelection",
    selectionMode: "after",
    focus: false,
    feedback: false,
    scrollIntoView: false,
  });
  if (inserted) focusVisualTexField(field);
  return inserted;
}

function requestCompletion(
  host: HTMLElement,
  field: MathfieldElement,
  applyLayout?: (layout: VisualTexDisplayLayout, prefix: string, deleteBefore: number) => boolean,
): void {
  const prefix = completionPrefix(field);
  const rect = visualTexCompletionRect(field);
  host.dispatchEvent(new CustomEvent<VisualTexMathCompletionRequest>("aaronnote:math-completion-request", {
    bubbles: true,
    detail: {
      prefix,
      rect: { left: rect.left, top: rect.top, bottom: rect.bottom },
      apply: (template, deleteBefore) => applyVisualTexCompletionTemplate(field, prefix, template, deleteBefore),
      ...(applyLayout ? {
        applyLayout: (layout, deleteBefore) => applyLayout(layout, prefix, deleteBefore),
      } : {}),
    },
  }));
}

export function visualTexCompletionRect(
  field: Pick<MathfieldElement, "getBoundingClientRect" | "shadowRoot">,
): { left: number; top: number; bottom: number } {
  const caret = field.shadowRoot?.querySelector<HTMLElement>(
    ".ML__caret, .ML__text-caret, .ML__latex-caret",
  );
  const caretRect = caret?.getBoundingClientRect();
  if (caretRect && Number.isFinite(caretRect.right) && Number.isFinite(caretRect.bottom)) {
    return { left: caretRect.right, top: caretRect.top, bottom: caretRect.bottom };
  }
  const fieldRect = field.getBoundingClientRect();
  return { left: fieldRect.left, top: fieldRect.top, bottom: fieldRect.bottom };
}

function refreshCompletion(
  host: HTMLElement,
  field: MathfieldElement,
  applyLayout?: (layout: VisualTexDisplayLayout, prefix: string, deleteBefore: number) => boolean,
): void {
  queueMicrotask(() => {
    if (host.isConnected && field.isConnected) requestCompletion(host, field, applyLayout);
  });
}

function closeCompletion(host: HTMLElement): void {
  host.dispatchEvent(new CustomEvent("aaronnote:math-completion-close", { bubbles: true }));
}

function completionConsumesKey(host: HTMLElement, key: VisualTexMathHostKey): boolean {
  const event = new CustomEvent<VisualTexMathHostKey>("aaronnote:math-completion-key", {
    bubbles: true,
    cancelable: true,
    detail: key,
  });
  host.dispatchEvent(event);
  return event.defaultPrevented;
}

function typedText(field: MathfieldElement, text: string): boolean {
  focusVisualTexField(field);
  return field.executeCommand(["typedText", text, {
    focus: false,
    feedback: false,
    simulateKeystroke: true,
  }]);
}

export type VisualTexSpaceAction = "command" | "space" | "navigate" | "boundary" | "none";

/**
 * Apply one physical Space key without delegating it to MathLive's shortcut
 * stack.
 *
 * MathLive has three genuinely different space states:
 *
 * - in LaTeX command mode, Space terminates `\\command` and must not append a
 *   spacing command;
 * - in `\\text{...}`, it is an ordinary text character;
 * - in math mode, it first performs MathLive's natural `moveAfterParent`
 *   transition; at the root it records one ignored source-space boundary.
 *   Neither path inserts a visible `\\ ` or `\\,` spacing command, and repeated
 *   Space does not accumulate duplicate boundaries.
 *
 * Keeping this transition in one adapter prevents the inline, display and
 * studio editors from drifting into different Space behaviours.
 */
export function insertVisualTexNaturalSpace(field: MathfieldElement): VisualTexSpaceAction {
  finishInactiveVisualTexSnippetPromptSessions(field);
  if (field.mode === "latex") {
    // This is MathLive's native `[Space]` transition for an unfinished
    // backslash command. It also removes the transient command/suggestion box.
    return field.executeCommand(["complete", "accept-all"]) ? "command" : "none";
  }
  if (field.mode === "text") {
    focusVisualTexField(field);
    return field.executeCommand(["typedText", " ", {
      focus: false,
      feedback: false,
      simulateKeystroke: true,
    }]) ? "space" : "none";
  }
  const before = visualTexSelectionKey(field);
  withVisualTexUndoRecordingSuspended(field, () => {
    field.executeCommand("moveAfterParent");
  });
  if (visualTexSelectionKey(field) !== before) return "navigate";

  const range = field.selection.ranges[0];
  if (!range || field.selection.ranges.length !== 1 || range[0] !== range[1]) return "none";
  if (visualTexLastSourceSpaceBoundary.get(field) === field.position) return "boundary";
  const sourceBefore = visualTexMathfieldRangeLatex(field, 0, field.position);
  if (/\s$/u.test(sourceBefore)) return "boundary";
  const inserted = field.insert(VISUAL_TEX_SOURCE_SPACE_MARKER, {
    format: "latex",
    insertionMode: "insertAfter",
    selectionMode: "after",
    focus: false,
    feedback: false,
    scrollIntoView: false,
  });
  if (inserted) visualTexLastSourceSpaceBoundary.set(field, field.position);
  return inserted ? "boundary" : "none";
}

type VisualTexNavigationField = Pick<
  MathfieldElement,
  "position" | "lastOffset" | "selection" | "executeCommand"
>;

function visualTexSelectionKey(field: Pick<MathfieldElement, "position" | "selection">): string {
  return `${field.position}:${field.selection.ranges
    .map(([from, to]) => `${from}-${to}`)
    .join(",")}`;
}

function collapsedAtMathfieldBoundary(
  field: Pick<MathfieldElement, "position" | "lastOffset" | "selection">,
  backward: boolean,
): boolean {
  const range = field.selection.ranges[0];
  if (!range || field.selection.ranges.length !== 1 || range[0] !== range[1]) return false;
  return backward ? field.position <= 0 : field.position >= field.lastOffset;
}

export function visualTexExplicitCommitDirection(
  key: VisualTexMathHostKey,
): "submit" | "save" | null {
  if (!(key.metaKey || key.ctrlKey) || key.altKey) return null;
  const normalized = key.key === "Esc" ? "Escape" : key.key;
  if (normalized === "Enter") return "submit";
  if (!key.shiftKey && normalized.toLowerCase() === "s") return "save";
  return null;
}

function requestVisualTexSave(): void {
  // Committing removes in-place widget hosts synchronously. Dispatch from the
  // stable document on the next microtask, after the source transaction lands.
  queueMicrotask(() => document.dispatchEvent(new CustomEvent("aaronnote:visualtex-save-request")));
}

export function visualTexMathfieldMovementCommand(
  key: VisualTexMathHostKey,
): Selector | null {
  const normalized = key.key === "Esc" ? "Escape" : key.key;
  const modifierCount = Number(Boolean(key.metaKey)) + Number(Boolean(key.ctrlKey)) + Number(Boolean(key.altKey));
  if (modifierCount > 1) return null;
  if (key.metaKey) {
    if (normalized === "ArrowLeft") {
      return key.shiftKey ? "extendToMathFieldStart" : "moveToMathfieldStart";
    }
    if (normalized === "ArrowRight") {
      return key.shiftKey ? "extendToMathFieldEnd" : "moveToMathfieldEnd";
    }
    return null;
  }
  if (key.ctrlKey) {
    if (normalized === "ArrowLeft") {
      return key.shiftKey ? "extendToGroupStart" : "moveToGroupStart";
    }
    if (normalized === "ArrowRight") {
      return key.shiftKey ? "extendToGroupEnd" : "moveToGroupEnd";
    }
    return null;
  }
  if (key.altKey) {
    if (normalized === "ArrowLeft") {
      return key.shiftKey ? "extendToPreviousWord" : "moveToPreviousWord";
    }
    if (normalized === "ArrowRight") {
      return key.shiftKey ? "extendToNextWord" : "moveToNextWord";
    }
    return null;
  }
  if (normalized === "ArrowLeft") {
    return key.shiftKey ? "extendSelectionBackward" : "moveToPreviousChar";
  }
  if (normalized === "ArrowRight") {
    return key.shiftKey ? "extendSelectionForward" : "moveToNextChar";
  }
  if (normalized === "ArrowUp") {
    return key.shiftKey ? "extendSelectionUpward" : "moveUp";
  }
  if (normalized === "ArrowDown") {
    return key.shiftKey ? "extendSelectionDownward" : "moveDown";
  }
  if (normalized === "Home") {
    return key.shiftKey ? "extendToMathFieldStart" : "moveToMathfieldStart";
  }
  if (normalized === "End") {
    return key.shiftKey ? "extendToMathFieldEnd" : "moveToMathfieldEnd";
  }
  if (normalized === "PageUp") {
    return key.shiftKey ? "extendToGroupStart" : "moveToGroupStart";
  }
  if (normalized === "PageDown") {
    return key.shiftKey ? "extendToGroupEnd" : "moveToGroupEnd";
  }
  return null;
}

export function visualTexMathfieldDeletionCommand(
  key: VisualTexMathHostKey,
): Selector | null {
  const normalized = key.key;
  if (normalized !== "Backspace" && normalized !== "Delete") return null;
  if (key.metaKey && !key.ctrlKey && !key.altKey) {
    return normalized === "Backspace" ? "deleteToMathFieldStart" : "deleteToMathFieldEnd";
  }
  if (key.ctrlKey && !key.metaKey && !key.altKey) {
    if (key.shiftKey && normalized === "Backspace") return "deleteToGroupEnd";
    return normalized === "Backspace" ? "deleteToGroupStart" : "deleteToGroupEnd";
  }
  if (key.altKey && !key.metaKey && !key.ctrlKey) {
    return normalized === "Backspace" ? "deletePreviousWord" : "deleteNextWord";
  }
  if (key.metaKey || key.ctrlKey || key.altKey) return null;
  return normalized === "Backspace" && key.shiftKey ? "deleteForward"
    : normalized === "Backspace" ? "deleteBackward"
      : "deleteForward";
}

function runCommonMathfieldKey(
  host: HTMLElement,
  field: MathfieldElement,
  key: VisualTexMathHostKey,
  checkCompletion = true,
): "handled" | "commit" | "continue" {
  if (checkCompletion && completionConsumesKey(host, key)) return "handled";
  const primary = Boolean(key.metaKey || key.ctrlKey);
  const normalized = key.key === "Esc" ? "Escape" : key.key;
  if (primary && !key.altKey) {
    const lower = normalized.toLowerCase();
    if (lower === "a") {
      selectAllVisualTexMathfield(field);
      return "handled";
    }
    if (lower === "z") {
      field.executeCommand(key.shiftKey ? "redo" : "undo");
      refreshCompletion(host, field);
      return "handled";
    }
  }
  const movement = visualTexMathfieldMovementCommand(key);
  if (movement) {
    withVisualTexUndoRecordingSuspended(field, () => {
      field.executeCommand(movement);
    });
    finishInactiveVisualTexSnippetPromptSessions(field);
    closeCompletion(host);
    return "handled";
  }
  const deletion = visualTexMathfieldDeletionCommand(key);
  if (deletion) {
    finishInactiveVisualTexSnippetPromptSessions(field);
    field.executeCommand(deletion);
    // MathLive snapshots deletion commands before mutating the tree. Reusing
    // the same operation key replaces that provisional entry with the actual
    // post-delete state: immediate undo still restores the deletion, while a
    // following insertion can undo back to the genuinely deleted value.
    snapshotVisualTexUndoState(field, String(deletion));
    refreshCompletion(host, field);
    return "handled";
  }
  if (primary || key.altKey) return "continue";
  if (normalized === "Escape") return "commit";
  const text = typeof key.text === "string" ? key.text : normalized.length === 1 ? normalized : "";
  if (text) {
    finishInactiveVisualTexSnippetPromptSessions(field);
    typedText(field, text);
    refreshCompletion(host, field);
    return "handled";
  }
  return "continue";
}

type VisualTexTabstopMove = "placeholder" | "edge" | "boundary";

function moveVisualTexTabstop(field: MathfieldElement, backward: boolean): VisualTexTabstopMove {
  const registered = moveVisualTexSnippetPrompt(field, backward);
  if (registered === "moved") return "placeholder";
  if (registered === "final") return "edge";
  if (registered === "exhausted") {
    const edge = backward ? 0 : field.lastOffset;
    if (field.position !== edge) {
      withVisualTexUndoRecordingSuspended(field, () => {
        field.executeCommand(backward ? "moveToMathfieldStart" : "moveToMathfieldEnd");
      });
      return "edge";
    }
    return "boundary";
  }
  finishInactiveVisualTexSnippetPromptSessions(field);
  // MathLive's native placeholder traversal is intentionally not a fallback:
  // Noema prompts are the sole snippet state, and the native command wraps at
  // the root, which makes Tab/Cmd-] jump back to the first formula atom.
  const edge = backward ? 0 : field.lastOffset;
  if (field.position !== edge) {
    withVisualTexUndoRecordingSuspended(field, () => {
      field.executeCommand(backward ? "moveToMathfieldStart" : "moveToMathfieldEnd");
    });
    return "edge";
  }
  return "boundary";
}

/**
 * One explicit Cmd-[ / Cmd-] transition.
 *
 * The order is intentional and does not require an external "armed" flag:
 *   1. a command that starts at the root edge exits immediately;
 *   2. otherwise visit the next/previous unresolved MathLive slot;
 *   3. with no slot, leave the nearest enclosing TeX parent (`}` boundary);
 *   4. with no enclosing parent, move to the root edge;
 *   5. the following command starts at that edge and exits.
 */
export type VisualTexNavigationStep = "placeholder" | "final" | "parent" | "edge" | "exit";

function keepVisualTexNavigationDirectional(
  field: VisualTexNavigationField,
  backward: boolean,
  origin: number,
  step: VisualTexNavigationStep,
): VisualTexNavigationStep {
  // Finishing a snippet reparses the formula without prompt wrapper atoms.
  // Offsets before and after that reparse are different coordinate spaces;
  // its `$0` position is mapped explicitly by finishVisualTexSnippetPromptSession.
  if (step === "exit" || step === "final") return step;
  const wrapped = backward ? field.position > origin : field.position < origin;
  if (!wrapped) return step;

  // MathLive models nested branches in one offset space, so leaving a real
  // parent is directional. A smaller offset after Cmd-] (or a larger one after
  // Cmd-[) can only be provider/selection wraparound. Collapse that illegal
  // transition to the requested root edge; never expose the formula-start
  // jump to the user.
  withVisualTexUndoRecordingSuspended(field as object, () => {
    field.executeCommand(backward ? "moveToMathfieldStart" : "moveToMathfieldEnd");
  });
  return "edge";
}

function moveVisualTexPastTextRun(
  field: VisualTexNavigationField,
  backward: boolean,
): boolean {
  const modeField = field as VisualTexNavigationField & Partial<Pick<MathfieldElement, "mode" | "getValue">>;
  if (modeField.mode !== "text") return false;
  let moved = false;
  // `\\text{...}` is represented as a run of text atoms at the root rather
  // than an addressable group, so moveAfterParent alone cannot leave it.
  for (let count = 0; count <= field.lastOffset + 1; count++) {
    if (modeField.getValue) {
      const from = backward ? Math.max(0, field.position - 1) : field.position;
      const to = backward ? field.position : Math.min(field.lastOffset, field.position + 1);
      if (!/^\\text\{/.test(modeField.getValue(from, to, "latex"))) break;
    }
    const before = visualTexSelectionKey(field);
    withVisualTexUndoRecordingSuspended(field as object, () => {
      field.executeCommand(backward ? "moveToPreviousChar" : "moveToNextChar");
    });
    if (visualTexSelectionKey(field) === before) break;
    moved = true;
    if (modeField.mode !== "text") break;
  }
  return moved;
}

export function advanceVisualTexNavigation(
  field: VisualTexNavigationField,
  backward: boolean,
): VisualTexNavigationStep {
  const origin = field.position;
  const finish = (step: VisualTexNavigationStep): VisualTexNavigationStep => (
    keepVisualTexNavigationDirectional(field, backward, origin, step)
  );
  const registered = moveVisualTexSnippetPrompt(field as object, backward);
  if (registered === "moved") return finish("placeholder");
  if (registered === "final") return finish("final");
  if (registered === "none") finishInactiveVisualTexSnippetPromptSessions(field as object);
  if (collapsedAtMathfieldBoundary(field, backward)) {
    // A trailing `\\text{...}` reports text mode even though its caret is
    // already at the root edge. Switching mode here changes no visible state
    // and used to make the first Cmd-] look broken; an edge command exits.
    return "exit";
  }

  if (registered === "exhausted") {
    // Prompts are editor-only wrappers. Leave one without spending a visible
    // structural Cmd-bracket transition on that artificial parent.
    withVisualTexUndoRecordingSuspended(field as object, () => {
      field.executeCommand(backward ? "moveBeforeParent" : "moveAfterParent");
    });
    if (collapsedAtMathfieldBoundary(field, backward)) return finish("edge");
  }

  if (moveVisualTexPastTextRun(field, backward)) {
    return finish(collapsedAtMathfieldBoundary(field, backward) ? "edge" : "parent");
  }

  const beforeParent = visualTexSelectionKey(field);
  withVisualTexUndoRecordingSuspended(field as object, () => {
    field.executeCommand(backward ? "moveBeforeParent" : "moveAfterParent");
  });
  if (visualTexSelectionKey(field) !== beforeParent) {
    return finish(collapsedAtMathfieldBoundary(field, backward) ? "edge" : "parent");
  }

  withVisualTexUndoRecordingSuspended(field as object, () => {
    field.executeCommand(backward ? "moveToMathfieldStart" : "moveToMathfieldEnd");
  });
  return finish("edge");
}

function addHostKeyBridge(
  host: HTMLElement,
  currentField: () => MathfieldElement | null,
  onKey: (field: MathfieldElement, key: VisualTexMathHostKey) => boolean,
): () => void {
  const listener = (event: Event): void => {
    const custom = event as CustomEvent<VisualTexMathHostKey>;
    const field = currentField();
    if (!field || !host.isConnected || custom.defaultPrevented) return;
    if (!onKey(field, custom.detail ?? { key: "" })) return;
    custom.preventDefault();
    custom.stopPropagation();
  };
  document.addEventListener("aaronnote:math-host-key", listener);
  return () => document.removeEventListener("aaronnote:math-host-key", listener);
}

export function insertVisualTexInlineRow(field: MathfieldElement): string {
  // Enter is a structural edit, not another way to leave a live snippet
  // prompt behind. Flatten its editor-only wrappers before taking the source
  // split so the resulting row never serializes prompt atoms.
  finishAllVisualTexSnippetPromptSessions(field);
  // MathLive currently reports `addRowAfter` as handled even at the ordinary
  // root, where there is no array row to add. Only accept the command when it
  // actually changed the TeX; otherwise promote the formula to `aligned`.
  const before = visualTexMathfieldLatex(field);
  const selection = field.selection.ranges[0] ?? [field.position, field.position];
  const from = Math.min(selection[0], selection[1]);
  const to = Math.max(selection[0], selection[1]);
  const left = visualTexMathfieldRangeLatex(field, 0, from);
  const right = visualTexMathfieldRangeLatex(field, to, field.lastOffset);
  field.executeCommand("addRowAfter");
  const after = visualTexMathfieldLatex(field);
  if (after !== before && visualTexSupportsRows(after)) return after;
  const next = `\\begin{aligned}${left}\\\\${right || "{}"}\\end{aligned}`;
  // setValue() resets MathLive's undo manager. A user-visible Enter must be a
  // normal replace-all edit so the scalar equation remains one Cmd-Z away and
  // redo can restore the promoted row layout.
  stopVisualTexUndoCoalescing(field);
  field.insert(next, {
    format: "latex",
    mode: "math",
    insertionMode: "replaceAll",
    selectionMode: "after",
    focus: false,
    feedback: false,
    scrollIntoView: false,
  });
  stopVisualTexUndoCoalescing(field);
  withVisualTexUndoRecordingSuspended(field, () => {
    field.executeCommand("moveToMathfieldEnd");
  });
  focusVisualTexField(field);
  return visualTexMathfieldLatex(field);
}

function createVisualTexQuickbar(
  host: HTMLElement,
  field: MathfieldElement,
  status: string,
  onChange: () => void,
): { element: HTMLElement; setStatus: (status: string) => void } {
  const bar = document.createElement("div");
  bar.className = "noema-visualtex-quickbar";
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", "LiveTeX 快速公式栏");

  const brand = document.createElement("strong");
  brand.textContent = "LiveTeX";
  const state = document.createElement("span");
  state.className = "noema-visualtex-quick-status";
  state.textContent = status;
  bar.append(brand, state);

  const button = (label: string, title: string, action: () => void, changes = true): void => {
    const control = document.createElement("button");
    control.type = "button";
    control.textContent = label;
    control.title = title;
    control.setAttribute("aria-label", title);
    control.addEventListener("mousedown", (event) => event.preventDefault());
    control.addEventListener("click", () => {
      action();
      if (changes) onChange();
      focusVisualTexField(field);
      closeCompletion(host);
    });
    bar.append(control);
  };
  button("B", "粗体", () => field.applyStyle({ variantStyle: "bold" }, { operation: "toggle" }));
  button("I", "斜体", () => field.applyStyle({ variantStyle: "italic" }, { operation: "toggle" }));
  button("↹", "下一个占位符", () => { moveVisualTexTabstop(field, false); }, false);
  button("全选", "选择整个公式", () => { selectAllVisualTexMathfield(field); }, false);

  return {
    element: bar,
    setStatus: (nextStatus) => { state.textContent = nextStatus; },
  };
}

export function mountVisualTexInlineEditor(
  host: HTMLElement,
  options: VisualTexInlineEditorOptions,
): VisualTexInlineEditor {
  let destroyed = false;
  let field: MathfieldElement | null = null;
  let draft = normalizeVisualTexLatex(options.latex);
  let removeHostKeyBridge = (): void => {};
  let suppressMoveOutCommit = false;

  const syncDraft = (): void => {
    if (!field) return;
    draft = syncVisualTexMathfieldDraft(field, options.onInput);
  };

  const moveTabstop = (active: MathfieldElement, backward: boolean): void => {
    suppressMoveOutCommit = true;
    try {
      moveVisualTexTabstop(active, backward);
    } finally {
      suppressMoveOutCommit = false;
    }
  };

  const moveWithinOrOut = (
    active: MathfieldElement,
    backward: boolean,
    exitDirection: VisualTexInlineMoveDirection,
  ): void => {
    suppressMoveOutCommit = true;
    let result: VisualTexNavigationStep;
    try {
      result = advanceVisualTexNavigation(active, backward);
    } finally {
      suppressMoveOutCommit = false;
    }
    closeCompletion(host);
    if (result === "exit") {
      syncDraft();
      options.onCommit(exitDirection);
    }
  };

  const handleSpace = (active: MathfieldElement, key: VisualTexMathHostKey): void => {
    // Text spaces are content, never a company-accept shortcut. In command and
    // math mode an exact Noema snippet keeps the historical Space-to-accept
    // gesture before the structural MathLive fallback runs.
    if (active.mode !== "text" && completionConsumesKey(host, key)) return;
    insertVisualTexNaturalSpace(active);
    // Completing a `\\command` emits an input event synchronously and can
    // otherwise reopen company for the just-finished prefix.
    closeCompletion(host);
  };

  const ready = loadMathLive()
    .then((module) => {
      if (destroyed) return;
      const Constructor = module.MathfieldElement;
      if (!Constructor) throw new Error("MathLive MathfieldElement is unavailable in this runtime");

      const next = createNoemaMathfield(Constructor);
      field = next;
      Constructor.locale = "zh-cn";
      next.className = "noema-visualtex-mathfield";
      next.dataset.aaronnoteVim = "native";
      initializeNoemaMathfield(next, draft, options.macros);
      next.setAttribute("aria-label", "编辑行内公式");
      next.removeAttribute("placeholder");

      const commitFromKey = (key: VisualTexMathHostKey): boolean => {
        const direction = visualTexExplicitCommitDirection(key);
        if (!direction) return false;
        syncDraft();
        options.onCommit(direction);
        if (direction === "save") requestVisualTexSave();
        return true;
      };
      const quickbar = createVisualTexQuickbar(host, next, "Inline", () => {
        syncDraft();
      });

      const handleInlineKey = (active: MathfieldElement, key: VisualTexMathHostKey): boolean => {
        if (commitFromKey(key)) return true;
        const normalized = key.key === "Esc" ? "Escape" : key.key;
        if (normalized === " ") {
          handleSpace(active, key);
          return true;
        }
        const common = runCommonMathfieldKey(host, active, key);
        if (common === "commit") {
          syncDraft();
          options.onCommit("forward");
          return true;
        }
        if (common === "handled") return true;
        if (normalized === "Enter") {
          // Inline formulae are single-line editing surfaces. Plain Enter
          // accepts; display editors use it to create a structural row.
          syncDraft();
          options.onCommit("forward");
          return true;
        }
        if (normalized === "Tab") {
          requestCompletion(host, active);
          if (!completionConsumesKey(host, key)) moveTabstop(active, Boolean(key.shiftKey));
          return true;
        }
        const bracketDirection = visualTexBracketDirection(key);
        if (bracketDirection) {
          moveWithinOrOut(active, bracketDirection === "backward", bracketDirection);
          return true;
        }
        return false;
      };

      next.addEventListener("input", () => {
        syncDraft();
        requestCompletion(host, next);
      });
      next.addEventListener("keydown", (event) => {
        if (event.isComposing) return;
        const key = {
          key: event.key,
          code: event.code,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          altKey: event.altKey,
          shiftKey: event.shiftKey,
        };
        if (!handleInlineKey(next, key)) return;
        event.preventDefault();
        event.stopPropagation();
      }, { capture: true });
      next.addEventListener("move-out", (event) => {
        event.preventDefault();
        if (suppressMoveOutCommit) return;
        syncDraft();
        options.onCommit(event.detail.direction);
      });
      next.addEventListener("blur", () => {
        queueMicrotask(() => {
          if (!destroyed && field && !field.hasFocus()) {
            syncDraft();
            options.onCommit();
          }
        });
      });

      const shell = document.createElement("span");
      shell.className = "noema-visualtex-inline-shell";
      shell.dataset.aaronnoteVim = "native";
      shell.append(quickbar.element, next);
      host.replaceChildren(shell);
      removeHostKeyBridge = addHostKeyBridge(host, () => field, handleInlineKey);
      window.requestAnimationFrame(() => {
        if (destroyed || field !== next || !next.isConnected) return;
        placeInitialSelection(next, options.entry);
        focusVisualTexField(next);
        closeCompletion(host);
      });
    })
    .catch((error) => {
      if (!destroyed) options.onUnavailable(error);
    });

  return {
    ready,
    value: () => field ? visualTexMathfieldLatex(field) : draft,
    focus: () => focusVisualTexField(field),
    destroy: () => {
      destroyed = true;
      closeCompletion(host);
      removeHostKeyBridge();
      field?.blur();
      field = null;
    },
  };
}

function mountVisualTexSingleDisplayEditor(
  host: HTMLElement,
  options: VisualTexInlineEditorOptions,
): VisualTexInlineEditor {
  let destroyed = false;
  let field: MathfieldElement | null = null;
  const initial = normalizeVisualTexLatex(options.latex);
  let draft = prepareVisualTexDisplayLatex(initial);
  let removeHostKeyBridge = (): void => {};
  let mountedToolbar: HTMLElement | null = null;
  let mountedPalette: HTMLElement | null = null;
  let removePaletteDismissListener = (): void => {};
  let suppressMoveOutCommit = false;

  const closeColorPalette = (): void => {
    removePaletteDismissListener();
    removePaletteDismissListener = () => {};
    mountedPalette?.remove();
    mountedPalette = null;
  };

  const ready = loadMathLive()
    .then((module) => {
      if (destroyed) return;
      const Constructor = module.MathfieldElement;
      if (!Constructor) throw new Error("MathLive MathfieldElement is unavailable in this runtime");
      Constructor.locale = "zh-cn";
      const shell = document.createElement("div");
      shell.className = options.advanced
        ? "noema-visualtex-live is-advanced"
        : "noema-visualtex-live is-simple";
      shell.dataset.aaronnoteVim = "native";

      const toolbar = document.createElement("div");
      toolbar.className = "noema-visualtex-toolbar";
      toolbar.setAttribute("role", "toolbar");
      toolbar.setAttribute("aria-label", "LiveTeX 公式工具栏");
      if (!options.toolbarHost) {
        const brand = document.createElement("span");
        brand.className = "noema-visualtex-brand";
        brand.textContent = "LiveTeX";
        toolbar.append(brand);
      } else {
        toolbar.classList.add("is-external");
      }

      const layout = document.createElement("select");
      layout.className = "noema-visualtex-layout";
      layout.setAttribute("aria-label", "公式布局");
      const layouts: Array<[VisualTexDisplayLayout, string]> = [
        ["equation", "Equation"], ["align", "Align (numbered)"], ["align*", "Align"],
        ["aligned", "Aligned"], ["gather", "Gather (numbered)"], ["gather*", "Gather"],
        ["gathered", "Gathered"], ["split", "Split"], ["multline", "Multline"],
        ["cases", "Cases"], ["matrix", "Matrix"], ["pmatrix", "(Matrix)"], ["bmatrix", "[Matrix]"],
      ];
      for (const [value, label] of layouts) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        layout.append(option);
      }
      layout.value = visualTexDisplayLayout(draft);
      toolbar.append(layout);

      const next = createNoemaMathfield(Constructor);
      field = next;
      next.className = "noema-visualtex-mathfield noema-visualtex-display-mathfield";
      next.dataset.aaronnoteVim = "native";
      initializeNoemaMathfield(next, draft, options.macros);
      next.setAttribute("aria-label", "LiveTeX 独立公式编辑器");
      next.removeAttribute("placeholder");

      let quickbar: ReturnType<typeof createVisualTexQuickbar> | null = null;
      const emitDraft = (): void => {
        draft = syncVisualTexMathfieldDraft(next, options.onInput);
        layout.value = visualTexDisplayLayout(draft);
        quickbar?.setStatus(layout.value === "equation" ? "Display" : `Display · ${layout.value}`);
        updateRowControls();
      };
      const applyDisplayLayoutSnippet = (
        nextLayout: VisualTexDisplayLayout,
        prefix = "",
        deleteBefore = 0,
      ): boolean => {
        if (deleteBefore > 0 && !removeCompletionPrefix(next, prefix, deleteBefore)) return false;
        const converted = setVisualTexDisplayLayout(visualTexMathfieldLatex(next), nextLayout);
        finishAllVisualTexSnippetPromptSessions(next);
        stopVisualTexUndoCoalescing(next);
        next.insert(converted, {
          format: "latex",
          mode: "math",
          insertionMode: "replaceAll",
          selectionMode: "after",
          focus: false,
          feedback: false,
          scrollIntoView: false,
        });
        stopVisualTexUndoCoalescing(next);
        focusVisualTexField(next);
        emitDraft();
        return true;
      };
      const requestDisplayCompletion = (): void => {
        requestCompletion(host, next, applyDisplayLayoutSnippet);
      };
      const refreshDisplayCompletion = (): void => {
        refreshCompletion(host, next, applyDisplayLayoutSnippet);
      };
      const commitFromKey = (key: VisualTexMathHostKey): boolean => {
        const direction = visualTexExplicitCommitDirection(key);
        if (!direction) return false;
        emitDraft();
        options.onCommit(direction);
        if (direction === "save") requestVisualTexSave();
        return true;
      };

      const toolbarButton = (
        label: string,
        title: string,
        action: () => void,
      ): HTMLButtonElement => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.title = title;
        button.setAttribute("aria-label", title);
        button.addEventListener("mousedown", (event) => event.preventDefault());
        button.addEventListener("click", () => {
          action();
          emitDraft();
          focusVisualTexField(next);
          refreshDisplayCompletion();
        });
        toolbar.append(button);
        return button;
      };

      const addRow = toolbarButton("+ Row", "增加一行", () => { insertVisualTexInlineRow(next); });
      const removeRow = toolbarButton("− Row", "删除当前行", () => { next.executeCommand("removeRow"); });
      toolbarButton("B", "粗体", () => { next.applyStyle({ variantStyle: "bold" }, { operation: "toggle" }); });
      toolbarButton("I", "斜体", () => { next.applyStyle({ variantStyle: "italic" }, { operation: "toggle" }); });

      const colorTool = (
        glyph: string,
        title: string,
        initialColor: string,
        style: "color" | "backgroundColor",
      ): void => {
        const control = document.createElement("button");
        control.type = "button";
        control.className = `noema-visualtex-color-button is-${style}`;
        control.textContent = glyph;
        control.title = title;
        control.setAttribute("aria-label", title);
        control.setAttribute("aria-haspopup", "menu");
        control.style.setProperty("--noema-visualtex-tool-color", initialColor);
        control.addEventListener("mousedown", (event) => event.preventDefault());
        control.addEventListener("click", () => {
          if (mountedPalette?.dataset.style === style) {
            closeColorPalette();
            focusVisualTexField(next);
            return;
          }
          closeColorPalette();

          const savedRange = visualTexStyleRange(next);
          const palette = document.createElement("div");
          palette.className = `noema-visualtex-color-palette is-${style}`;
          palette.dataset.style = style;
          palette.setAttribute("role", "menu");
          palette.setAttribute("aria-label", title);

          const colors: Array<[string, string, string]> = [
            ["none", "清除", "transparent"],
            ["red", "红色", "#ef5350"],
            ["orange", "橙色", "#fb8c00"],
            ["yellow", "黄色", "#fdd835"],
            ["lime", "青柠", "#9ccc65"],
            ["green", "绿色", "#43a047"],
            ["teal", "青色", "#26a69a"],
            ["blue", "蓝色", "#4f7cff"],
            ["indigo", "靛蓝", "#5c6bc0"],
            ["purple", "紫色", "#ab47bc"],
            ["magenta", "洋红", "#ec407a"],
            ["black", "黑色", "#1f2430"],
            ["white", "白色", "#f4f6fb"],
          ];
          for (const [color, label, swatch] of colors) {
            const option = document.createElement("button");
            option.type = "button";
            option.className = "noema-visualtex-color-swatch";
            option.dataset.color = color;
            option.title = label;
            option.setAttribute("aria-label", label);
            option.setAttribute("role", "menuitem");
            option.style.setProperty("--noema-visualtex-swatch", swatch);
            option.addEventListener("mousedown", (event) => event.preventDefault());
            option.addEventListener("click", () => {
              applyVisualTexStyle(next, style, color, savedRange);
              control.style.setProperty("--noema-visualtex-tool-color", swatch);
              emitDraft();
              refreshDisplayCompletion();
              closeColorPalette();
              focusVisualTexField(next);
            });
            palette.append(option);
          }

          document.body.append(palette);
          mountedPalette = palette;
          const rect = control.getBoundingClientRect();
          const paletteWidth = 220;
          const left = Math.max(8, Math.min(rect.left, window.innerWidth - paletteWidth - 8));
          palette.style.left = `${left}px`;
          palette.style.top = `${Math.min(rect.bottom + 7, window.innerHeight - 70)}px`;
          queueMicrotask(() => {
            if (mountedPalette !== palette) return;
            const dismiss = (event: PointerEvent): void => {
              if (palette.contains(event.target as Node) || control.contains(event.target as Node)) return;
              closeColorPalette();
            };
            document.addEventListener("pointerdown", dismiss, true);
            removePaletteDismissListener = () => document.removeEventListener("pointerdown", dismiss, true);
          });
        });
        toolbar.append(control);
      };

      colorTool("A", "选择文字颜色", "#4f7cff", "color");
      colorTool("▰", "选择高亮颜色", "#fdd835", "backgroundColor");

      function updateRowControls(): void {
        const enabled = visualTexSupportsRows(visualTexMathfieldLatex(next));
        // Adding the first row promotes an equation to `aligned`; it should
        // never be a mysteriously disabled operation.
        addRow.disabled = false;
        removeRow.disabled = !enabled;
      }
      updateRowControls();

      layout.addEventListener("change", () => {
        applyDisplayLayoutSnippet(layout.value as VisualTexDisplayLayout);
      });

      const handleDisplayKey = (active: MathfieldElement, key: VisualTexMathHostKey): boolean => {
        if (commitFromKey(key)) return true;
        const normalized = key.key === "Esc" ? "Escape" : key.key;
        if (normalized === " ") {
          if (active.mode !== "text" && completionConsumesKey(host, key)) return true;
          insertVisualTexNaturalSpace(active);
          closeCompletion(host);
          return true;
        }
        if (completionConsumesKey(host, key)) return true;
        if (normalized === "Escape") {
          emitDraft();
          options.onCommit("forward");
          return true;
        }
        if (normalized === "Enter") {
          draft = insertVisualTexInlineRow(active);
          options.onInput(draft);
          layout.value = visualTexDisplayLayout(draft);
          refreshCompletion(host, active, applyDisplayLayoutSnippet);
          return true;
        }
        if (normalized === "Tab") {
          requestCompletion(host, active, applyDisplayLayoutSnippet);
          if (!completionConsumesKey(host, key)) {
            suppressMoveOutCommit = true;
            try {
              moveVisualTexTabstop(active, Boolean(key.shiftKey));
            } finally {
              suppressMoveOutCommit = false;
            }
          }
          return true;
        }
        const bracketDirection = visualTexBracketDirection(key);
        if (bracketDirection) {
          const backward = bracketDirection === "backward";
          suppressMoveOutCommit = true;
          let result: VisualTexNavigationStep;
          try {
            result = advanceVisualTexNavigation(active, backward);
          } finally {
            suppressMoveOutCommit = false;
          }
          closeCompletion(host);
          // Reaching the root edge only positions the caret. A second explicit
          // Cmd-] from that edge exits to the Markdown line below, matching the
          // inline editor and preventing a mid-formula command from closing it.
          if (result === "exit") {
            emitDraft();
            options.onCommit(bracketDirection);
          }
          return true;
        }
        return runCommonMathfieldKey(host, active, key, false) === "handled";
      };

      next.addEventListener("input", () => {
        emitDraft();
        requestDisplayCompletion();
      });
      next.addEventListener("keydown", (event) => {
        if (event.isComposing) return;
        const handled = handleDisplayKey(next, {
          key: event.key,
          code: event.code,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          altKey: event.altKey,
          shiftKey: event.shiftKey,
        });
        if (!handled) return;
        event.preventDefault();
        event.stopPropagation();
      }, { capture: true });
      next.addEventListener("move-out", (event) => {
        event.preventDefault();
        if (suppressMoveOutCommit) return;
        emitDraft();
        options.onCommit(event.detail.direction);
      });

      if (options.commitOnBlur !== false) {
        shell.addEventListener("focusout", () => {
          queueMicrotask(() => {
            if (!destroyed && !host.contains(document.activeElement)) {
              emitDraft();
              options.onCommit();
            }
          });
        });
      }

      if (options.advanced && options.toolbarHost) {
        options.toolbarHost.replaceChildren(toolbar);
        mountedToolbar = toolbar;
        shell.append(next);
      } else if (options.advanced) shell.append(toolbar, next);
      else {
        quickbar = createVisualTexQuickbar(host, next, "Display", emitDraft);
        shell.append(quickbar.element, next);
      }
      host.replaceChildren(shell);
      removeHostKeyBridge = addHostKeyBridge(host, () => field, handleDisplayKey);
      if (draft !== initial) options.onInput(draft);
      window.requestAnimationFrame(() => {
        if (destroyed || field !== next || !next.isConnected) return;
        placeInitialSelection(next, options.entry);
        focusVisualTexField(next);
        closeCompletion(host);
      });
    })
    .catch((error) => {
      if (!destroyed) options.onUnavailable(error);
    });

  return {
    ready,
    value: () => field ? visualTexMathfieldLatex(field) : draft,
    focus: () => focusVisualTexField(field),
    destroy: () => {
      destroyed = true;
      closeCompletion(host);
      closeColorPalette();
      removeHostKeyBridge();
      mountedToolbar?.remove();
      mountedToolbar = null;
      field?.blur();
      field = null;
    },
  };
}

type VisualTexDisplayRow = {
  element: HTMLElement;
  number: HTMLElement;
  field: MathfieldElement;
};

function mountVisualTexAdvancedDisplayEditor(
  host: HTMLElement,
  options: VisualTexInlineEditorOptions,
): VisualTexInlineEditor {
  let destroyed = false;
  const initial = prepareVisualTexDisplayLatex(normalizeVisualTexLatex(options.latex));
  let draft = initial;
  let currentLayout = visualTexDisplayLayout(initial);
  let activeField: MathfieldElement | null = null;
  let rows: VisualTexDisplayRow[] = [];
  let removeHostKeyBridge = (): void => {};
  let mountedToolbar: HTMLElement | null = null;
  let mountedPalette: HTMLElement | null = null;
  let removePaletteDismissListener = (): void => {};
  let suppressMoveOutCommit = false;

  const closeColorPalette = (): void => {
    removePaletteDismissListener();
    removePaletteDismissListener = () => {};
    mountedPalette?.remove();
    mountedPalette = null;
  };

  const ready = loadMathLive()
    .then((module) => {
      if (destroyed) return;
      const Constructor = module.MathfieldElement;
      if (!Constructor) throw new Error("MathLive MathfieldElement is unavailable in this runtime");
      Constructor.locale = "zh-cn";

      const shell = document.createElement("div");
      shell.className = "noema-visualtex-live is-advanced";
      shell.dataset.aaronnoteVim = "native";

      const toolbar = document.createElement("div");
      toolbar.className = "noema-visualtex-toolbar";
      toolbar.setAttribute("role", "toolbar");
      toolbar.setAttribute("aria-label", "LiveTeX 公式工具栏");
      if (!options.toolbarHost) {
        const brand = document.createElement("span");
        brand.className = "noema-visualtex-brand";
        brand.textContent = "LiveTeX";
        toolbar.append(brand);
      } else toolbar.classList.add("is-external");

      const layout = document.createElement("select");
      layout.className = "noema-visualtex-layout";
      layout.setAttribute("aria-label", "外层公式布局");
      const layouts: Array<[VisualTexDisplayLayout, string]> = [
        ["equation", "Equation"], ["align", "Align (numbered)"], ["align*", "Align"],
        ["aligned", "Aligned"], ["gather", "Gather (numbered)"], ["gather*", "Gather"],
        ["gathered", "Gathered"], ["split", "Split"], ["multline", "Multline"],
        ["cases", "Cases"], ["matrix", "Matrix"], ["pmatrix", "(Matrix)"], ["bmatrix", "[Matrix]"],
      ];
      for (const [value, label] of layouts) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        layout.append(option);
      }
      layout.value = currentLayout;
      toolbar.append(layout);

      const rowList = document.createElement("div");
      rowList.className = "noema-visualtex-formula-rows";

      const rowValues = (): string[] => rows.map(({ field }) => visualTexMathfieldLatex(field));
      const emitDraft = (): void => {
        draft = serializeVisualTexDisplayRows(currentLayout, rowValues());
        options.onInput(draft);
      };
      const commitFromKey = (key: VisualTexMathHostKey): boolean => {
        const direction = visualTexExplicitCommitDirection(key);
        if (!direction) return false;
        emitDraft();
        options.onCommit(direction);
        if (direction === "save") requestVisualTexSave();
        return true;
      };
      const activeRowIndex = (): number => Math.max(0, rows.findIndex(({ field }) => field === activeField));
      const focusRow = (index: number, atEnd = false): void => {
        const row = rows[Math.max(0, Math.min(index, rows.length - 1))];
        if (!row) return;
        activeField = row.field;
        // Crossing studio rows is caret navigation. Do not let MathLive turn
        // that programmatic selection/mode switch into an invisible undo step.
        withVisualTexUndoRecordingSuspended(row.field, () => {
          row.field.position = atEnd ? row.field.lastOffset : 0;
        });
        stopVisualTexUndoCoalescing(row.field);
        focusVisualTexField(row.field);
        closeCompletion(host);
      };
      const renumberRows = (): void => {
        rows.forEach((row, index) => {
          row.number.textContent = String(index + 1).padStart(2, "0");
          row.field.setAttribute("aria-label", `LiveTeX 公式第 ${index + 1} 行`);
        });
        updateRowControls();
      };

      let addRowButton: HTMLButtonElement;
      let removeRowButton: HTMLButtonElement;
      function updateRowControls(): void {
        const enabled = currentLayout !== "equation";
        if (addRowButton) addRowButton.disabled = false;
        if (removeRowButton) removeRowButton.disabled = !enabled || rows.length <= 1;
      }

      const applyOuterLayout = (
        nextLayout: VisualTexDisplayLayout,
        sourceField?: MathfieldElement,
        prefix = "",
        deleteBefore = 0,
      ): boolean => {
        if (sourceField && deleteBefore > 0
          && !removeCompletionPrefix(sourceField, prefix, deleteBefore)) return false;
        if (nextLayout === "equation" && rows.length > 1) {
          const [first, ...rest] = rows;
          const merged = rowValues().filter(Boolean).join(" \\qquad ");
          // This conversion removes the other MathfieldElement instances, so
          // their independent undo stacks can no longer represent the prior
          // multi-row document. Reset the surviving field at this deliberate
          // structural boundary instead of exposing a partial undo that drops
          // every removed row's content.
          first!.field.setValue(merged, { selectionMode: "after", focus: false });
          rest.forEach((row) => {
            row.field.blur();
            row.element.remove();
          });
          rows = [first!];
          activeField = first!.field;
        }
        currentLayout = nextLayout;
        layout.value = nextLayout;
        renumberRows();
        emitDraft();
        focusVisualTexField(activeField);
        closeCompletion(host);
        return true;
      };

      function requestRowCompletion(target: MathfieldElement): void {
        requestCompletion(host, target, (nextLayout, prefix, deleteBefore) => (
          applyOuterLayout(nextLayout, target, prefix, deleteBefore)
        ));
      }

      const createRow = (latex: string): VisualTexDisplayRow => {
        const element = document.createElement("article");
        element.className = "noema-visualtex-formula-row";
        const number = document.createElement("span");
        number.className = "noema-visualtex-row-number";
        const next = createNoemaMathfield(Constructor);
        next.className = "noema-visualtex-mathfield noema-visualtex-display-mathfield";
        next.dataset.aaronnoteVim = "native";
        next.removeAttribute("placeholder");
        initializeNoemaMathfield(next, latex, options.macros);
        element.append(number, next);

        next.addEventListener("focusin", () => {
          activeField = next;
        });
        next.addEventListener("input", () => {
          activeField = next;
          emitDraft();
          requestRowCompletion(next);
        });
        next.addEventListener("keydown", (event) => {
          if (event.isComposing) return;
          const handled = handleDisplayKey(next, {
            key: event.key,
            code: event.code,
            ctrlKey: event.ctrlKey,
            metaKey: event.metaKey,
            altKey: event.altKey,
            shiftKey: event.shiftKey,
          });
          if (!handled) return;
          event.preventDefault();
          event.stopPropagation();
        }, { capture: true });
        next.addEventListener("move-out", (event) => {
          event.preventDefault();
          if (suppressMoveOutCommit) return;
          const index = rows.findIndex(({ field }) => field === next);
          if ((event.detail.direction === "forward" || event.detail.direction === "downward") && index < rows.length - 1) {
            focusRow(index + 1);
            return;
          }
          if ((event.detail.direction === "backward" || event.detail.direction === "upward") && index > 0) {
            focusRow(index - 1, true);
            return;
          }
          emitDraft();
          options.onCommit(event.detail.direction);
        });
        return { element, number, field: next };
      };

      const insertIndependentRow = (afterIndex = activeRowIndex()): void => {
        if (currentLayout === "equation") {
          // The first row gesture promotes a scalar display to a real row
          // layout, matching the simple display editor and its Enter key.
          currentLayout = "aligned";
          layout.value = currentLayout;
        }
        const row = createRow("");
        const index = Math.max(0, Math.min(afterIndex + 1, rows.length));
        rows.splice(index, 0, row);
        rowList.insertBefore(row.element, rowList.children[index] ?? null);
        renumberRows();
        emitDraft();
        focusRow(index);
      };
      const removeIndependentRow = (): void => {
        if (currentLayout === "equation" || rows.length <= 1) return;
        const index = activeRowIndex();
        const [removed] = rows.splice(index, 1);
        removed?.field.blur();
        removed?.element.remove();
        renumberRows();
        emitDraft();
        focusRow(Math.min(index, rows.length - 1), true);
      };

      const handleDisplayKey = (active: MathfieldElement, key: VisualTexMathHostKey): boolean => {
        activeField = active;
        if (commitFromKey(key)) return true;
        const normalized = key.key === "Esc" ? "Escape" : key.key;
        if (normalized === " ") {
          if (active.mode !== "text" && completionConsumesKey(host, key)) return true;
          insertVisualTexNaturalSpace(active);
          closeCompletion(host);
          return true;
        }
        if (completionConsumesKey(host, key)) return true;
        if (normalized === "Escape") {
          emitDraft();
          // Advanced mode is a modal studio; Escape must apply and close just
          // like its explicit edge command, not emit an ignored move direction.
          options.onCommit("submit");
          return true;
        }
        if (normalized === "Enter") {
          insertIndependentRow(activeRowIndex());
          return true;
        }
        if (normalized === "Tab") {
          requestRowCompletion(active);
          if (!completionConsumesKey(host, key)) {
            suppressMoveOutCommit = true;
            try {
              const result = moveVisualTexTabstop(active, Boolean(key.shiftKey));
              if (result === "boundary") {
                const index = activeRowIndex();
                if (key.shiftKey && index > 0) focusRow(index - 1, true);
                else if (!key.shiftKey && index < rows.length - 1) focusRow(index + 1);
              }
            } finally {
              suppressMoveOutCommit = false;
            }
          }
          return true;
        }
        const bracketDirection = visualTexBracketDirection(key);
        if (bracketDirection) {
          const backward = bracketDirection === "backward";
          suppressMoveOutCommit = true;
          let result: VisualTexNavigationStep;
          try {
            result = advanceVisualTexNavigation(active, backward);
          } finally {
            suppressMoveOutCommit = false;
          }
          closeCompletion(host);
          if (result === "exit") {
            const index = activeRowIndex();
            if (backward && index > 0) {
              focusRow(index - 1, true);
            } else if (!backward && index < rows.length - 1) {
              focusRow(index + 1);
            } else {
              emitDraft();
              // Advanced mode is the standalone studio. Its host deliberately
              // ignores passive MathLive move-out events; this explicit edge
              // command is a real apply-and-close request.
              options.onCommit("submit");
            }
          }
          return true;
        }
        return runCommonMathfieldKey(host, active, key, false) === "handled";
      };

      const toolbarButton = (label: string, title: string, action: () => void): HTMLButtonElement => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.title = title;
        button.setAttribute("aria-label", title);
        button.addEventListener("mousedown", (event) => event.preventDefault());
        button.addEventListener("click", () => {
          action();
          focusVisualTexField(activeField);
          closeCompletion(host);
        });
        toolbar.append(button);
        return button;
      };

      addRowButton = toolbarButton("+ Row", "增加独立公式行", () => insertIndependentRow());
      removeRowButton = toolbarButton("− Row", "删除当前公式行", removeIndependentRow);
      toolbarButton("B", "粗体", () => {
        activeField?.applyStyle({ variantStyle: "bold" }, { operation: "toggle" });
        emitDraft();
      });
      toolbarButton("I", "斜体", () => {
        activeField?.applyStyle({ variantStyle: "italic" }, { operation: "toggle" });
        emitDraft();
      });

      const colorTool = (
        glyph: string,
        title: string,
        initialColor: string,
        style: "color" | "backgroundColor",
      ): void => {
        const control = document.createElement("button");
        control.type = "button";
        control.className = `noema-visualtex-color-button is-${style}`;
        control.textContent = glyph;
        control.title = title;
        control.setAttribute("aria-label", title);
        control.setAttribute("aria-haspopup", "menu");
        control.style.setProperty("--noema-visualtex-tool-color", initialColor);
        control.addEventListener("mousedown", (event) => event.preventDefault());
        control.addEventListener("click", () => {
          const target = activeField ?? rows[0]?.field ?? null;
          if (!target) return;
          if (mountedPalette?.dataset.style === style) {
            closeColorPalette();
            focusVisualTexField(target);
            return;
          }
          closeColorPalette();
          const savedRange = visualTexStyleRange(target);
          const palette = document.createElement("div");
          palette.className = `noema-visualtex-color-palette is-${style}`;
          palette.dataset.style = style;
          palette.setAttribute("role", "menu");
          palette.setAttribute("aria-label", title);
          const colors: Array<[string, string, string]> = [
            ["none", "清除", "transparent"], ["red", "红色", "#ef5350"],
            ["orange", "橙色", "#fb8c00"], ["yellow", "黄色", "#fdd835"],
            ["lime", "青柠", "#9ccc65"], ["green", "绿色", "#43a047"],
            ["teal", "青色", "#26a69a"], ["blue", "蓝色", "#4f7cff"],
            ["indigo", "靛蓝", "#5c6bc0"], ["purple", "紫色", "#ab47bc"],
            ["magenta", "洋红", "#ec407a"], ["black", "黑色", "#1f2430"],
            ["white", "白色", "#f4f6fb"],
          ];
          for (const [color, label, swatch] of colors) {
            const option = document.createElement("button");
            option.type = "button";
            option.className = "noema-visualtex-color-swatch";
            option.dataset.color = color;
            option.title = label;
            option.setAttribute("aria-label", label);
            option.setAttribute("role", "menuitem");
            option.style.setProperty("--noema-visualtex-swatch", swatch);
            option.addEventListener("mousedown", (event) => event.preventDefault());
            option.addEventListener("click", () => {
              applyVisualTexStyle(target, style, color, savedRange);
              control.style.setProperty("--noema-visualtex-tool-color", swatch);
              emitDraft();
              closeColorPalette();
              closeCompletion(host);
              focusVisualTexField(target);
            });
            palette.append(option);
          }
          document.body.append(palette);
          mountedPalette = palette;
          const rect = control.getBoundingClientRect();
          const paletteWidth = 220;
          palette.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - paletteWidth - 8))}px`;
          palette.style.top = `${Math.min(rect.bottom + 7, window.innerHeight - 70)}px`;
          queueMicrotask(() => {
            if (mountedPalette !== palette) return;
            const dismiss = (event: PointerEvent): void => {
              if (palette.contains(event.target as Node) || control.contains(event.target as Node)) return;
              closeColorPalette();
            };
            document.addEventListener("pointerdown", dismiss, true);
            removePaletteDismissListener = () => document.removeEventListener("pointerdown", dismiss, true);
          });
        });
        toolbar.append(control);
      };
      colorTool("A", "选择文字颜色", "#4f7cff", "color");
      colorTool("▰", "选择高亮颜色", "#fdd835", "backgroundColor");

      layout.addEventListener("change", () => {
        applyOuterLayout(layout.value as VisualTexDisplayLayout);
      });

      const initialRows = managedLayoutDocument(initial).rows;
      for (const latex of initialRows.length ? initialRows : [""]) {
        const row = createRow(latex);
        rows.push(row);
        rowList.append(row.element);
      }
      activeField = rows[0]?.field ?? null;
      renumberRows();

      shell.append(rowList);
      if (options.toolbarHost) {
        options.toolbarHost.replaceChildren(toolbar);
        mountedToolbar = toolbar;
      } else shell.prepend(toolbar);
      host.replaceChildren(shell);
      removeHostKeyBridge = addHostKeyBridge(host, () => activeField, handleDisplayKey);

      if (options.commitOnBlur !== false) {
        shell.addEventListener("focusout", () => {
          queueMicrotask(() => {
            if (!destroyed && !host.contains(document.activeElement)) {
              emitDraft();
              options.onCommit();
            }
          });
        });
      }
      if (draft !== options.latex) options.onInput(draft);
      window.requestAnimationFrame(() => {
        const first = rows[0]?.field;
        if (destroyed || !first?.isConnected) return;
        activeField = first;
        placeInitialSelection(first, options.entry);
        focusVisualTexField(first);
        closeCompletion(host);
      });
    })
    .catch((error) => {
      if (!destroyed) options.onUnavailable(error);
    });

  return {
    ready,
    value: () => rows.length
      ? serializeVisualTexDisplayRows(currentLayout, rows.map(({ field }) => visualTexMathfieldLatex(field)))
      : draft,
    focus: () => focusVisualTexField(activeField ?? rows[0]?.field),
    destroy: () => {
      destroyed = true;
      closeCompletion(host);
      closeColorPalette();
      removeHostKeyBridge();
      mountedToolbar?.remove();
      mountedToolbar = null;
      rows.forEach(({ field }) => field.blur());
      rows = [];
      activeField = null;
    },
  };
}

export function mountVisualTexDisplayEditor(
  host: HTMLElement,
  options: VisualTexInlineEditorOptions,
): VisualTexInlineEditor {
  return options.advanced
    ? mountVisualTexAdvancedDisplayEditor(host, options)
    : mountVisualTexSingleDisplayEditor(host, options);
}
