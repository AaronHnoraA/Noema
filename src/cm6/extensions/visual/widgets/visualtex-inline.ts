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
  | { kind: "source"; offset: number }
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
  /** TeX-source offset corresponding to the current MathLive caret. */
  sourceOffset(): number;
  focus(): void;
  destroy(): void;
};

export type VisualTexPreviewPlaceholder = {
  offset: number;
  active?: boolean;
  mirror?: boolean;
};

export type VisualTexPreviewState = {
  latex: string;
  display: boolean;
  selection: { anchor: number; head: number };
  placeholders: readonly VisualTexPreviewPlaceholder[];
};

export type VisualTexPreview = {
  readonly ready: Promise<void>;
  update(state: VisualTexPreviewState): void;
  /** Stop all deferred synchronization while retaining the reusable field. */
  suspend(): void;
  destroy(): void;
};

export type VisualTexPreviewOptions = {
  macros: Record<string, string>;
  /**
   * A frame has been rendered. `contentChanged` is false for caret-only
   * updates, where the formula's size cannot have changed and the host can skip
   * re-measuring it.
   */
  onRendered?: (contentChanged: boolean) => void;
  onUnavailable?: (error: unknown) => void;
  onSourcePosition?: (offset: number) => void;
  /** Trailing source-to-MathLive synchronization delay, in milliseconds. */
  syncIdleMs?: number;
  /** Test/runtime injection; production shares the module-level lazy loader. */
  loadMathLive?: () => Promise<typeof import("mathlive")>;
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
    occurrenceIds: string[];
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

/**
 * Ask the owning document snippet to accept a move beyond LiveTeX's root.
 * Preventing this event is an explicit acknowledgement; without one the math
 * editor remains clamped at its boundary.
 */
export function requestVisualTexSnippetBoundaryHandoff(
  host: HTMLElement,
  backward: boolean,
): boolean {
  const event = new CustomEvent<{ direction: "forward" | "backward" }>(
    "aaronnote:math-snippet-boundary",
    {
      bubbles: true,
      cancelable: true,
      detail: { direction: backward ? "backward" : "forward" },
    },
  );
  host.dispatchEvent(event);
  return event.defaultPrevented;
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
    if (entry.kind === "source") {
      field.position = visualTexMathfieldPositionFromSourceOffset(field, entry.offset);
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
  options: { readOnlyMirror?: boolean } = {},
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
  if (!options.readOnlyMirror) {
    // A mirror is never focused and never scrolled to its caret, so these would
    // only schedule animation frames and walk the shadow tree for nothing — and
    // a fresh set is attached every time a failed commit rebuilds the field.
    field.addEventListener("input", () => revealVisualTexCaret(field));
    field.addEventListener("selection-change", () => revealVisualTexCaret(field));
    field.addEventListener("focusin", () => revealVisualTexCaret(field));
  }
  // Every MathLive selection command calls Mathfield.scrollIntoView(). Its
  // default first calls host.scrollIntoView({ inline: "nearest" }), which can
  // drag a wide display formula and the entire CM6 page back to the formula's
  // left edge. Supplying this callback disables that page-level branch while
  // retaining MathLive's own internal caret scrolling below it.
  if (!options.readOnlyMirror) field.onScrollIntoView = () => revealVisualTexCaret(field);
  configureNoemaMathfield(field);
  return field;
}

/** Read only standard TeX; transient snippet boundaries never enter the note. */
export function visualTexMathfieldLatex(field: Pick<MathfieldElement, "getValue">): string {
  synchronizeVisualTexSnippetMirrors(field as object);
  synchronizeVisualTexMacroTabstopArguments(field as object);
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

function visualTexMathfieldSourceOffset(field: MathfieldElement): number {
  return visualTexMathfieldRangeLatex(field, 0, field.position).length;
}

export function visualTexMathfieldPositionFromSourceOffset(
  field: MathfieldElement,
  sourceOffset: number,
): number {
  const target = Math.max(0, sourceOffset);
  let closest = 0;
  let distance = Number.POSITIVE_INFINITY;
  for (let position = 0; position <= field.lastOffset; position += 1) {
    const nextDistance = Math.abs(visualTexMathfieldRangeLatex(field, 0, position).length - target);
    if (nextDistance < distance) {
      closest = position;
      distance = nextDistance;
    }
    if (nextDistance === 0) break;
  }
  return closest;
}

export type VisualTexPreviewDraft = {
  latex: string;
  caretOffset: number | null;
  placeholders: readonly VisualTexPreviewPlaceholder[];
  sourceOffset(offset: number, affinity?: "before" | "after"): number;
};

function visualTexControlSequenceAtOffset(source: string, offset: number): [number, number] | null {
  let wordStart = offset;
  while (wordStart > 0 && /[A-Za-z@]/.test(source[wordStart - 1] ?? "")) wordStart--;
  if (wordStart > 0 && source[wordStart - 1] === "\\") {
    const from = wordStart - 1;
    let to = wordStart;
    while (to < source.length && /[A-Za-z@]/.test(source[to] ?? "")) to++;
    if (offset > from && offset < to) return [from, to];
  }
  if (offset > 0 && source[offset - 1] === "\\" && offset < source.length) {
    return [offset - 1, Math.min(source.length, offset + 1)];
  }
  return null;
}

/** Keep a preview-only atom from splitting a TeX control sequence. */
function visualTexPreviewSafeMarkerOffsetInSource(
  source: string,
  sourceOffset: number,
  affinity: "before" | "after" = "after",
): number {
  const requested = Math.max(0, Math.min(source.length, sourceOffset));
  let offset = requested;
  const control = visualTexControlSequenceAtOffset(source, requested);
  if (control) {
    const [from, to] = control;
    const midpoint = from + ((to - from) / 2);
    offset = requested < midpoint || (requested === midpoint && affinity === "before") ? from : to;
  }

  // Inserting between a script operator and its operand would turn the marker
  // into that operand. Snap to the operator boundary; source-side ^/_ helpers
  // normally make this transient state disappear immediately.
  let previous = offset - 1;
  while (previous >= 0 && /\s/.test(source[previous] ?? "")) previous--;
  if (source[previous] === "^" || source[previous] === "_") return previous;

  // Delimiter commands consume the next token. Keep the marker on the far
  // side of that token so \left( and friends continue to parse as one unit.
  const prefix = source.slice(0, offset);
  if (/\\(?:left|right|middle|big|Big|bigg|Bigg)[lr]?$/.test(prefix)) {
    let next = offset;
    while (next < source.length && /\s/.test(source[next] ?? "")) next++;
    if (source[next] === "\\") {
      const controlEnd = source.slice(next).match(/^\\(?:[A-Za-z@]+|.)/)?.[0].length ?? 1;
      return Math.min(source.length, next + controlEnd);
    }
    return Math.min(source.length, next + (next < source.length ? 1 : 0));
  }
  return offset;
}

export function visualTexPreviewSafeMarkerOffset(
  latex: string,
  sourceOffset: number,
  affinity: "before" | "after" = "after",
): number {
  return visualTexPreviewSafeMarkerOffsetInSource(
    normalizeVisualTexLatex(latex),
    sourceOffset,
    affinity,
  );
}

/** Keep preview metadata beside, never inside, the TeX source. */
export function buildVisualTexPreviewDraft(
  latex: string,
  placeholders: readonly VisualTexPreviewPlaceholder[],
  selection?: { anchor: number; head: number },
): VisualTexPreviewDraft {
  const source = normalizeVisualTexLatex(latex);
  const grouped = new Map<number, {
    active: boolean;
    mirror: boolean;
  }>();
  for (const placeholder of placeholders) {
    const offset = visualTexPreviewSafeMarkerOffsetInSource(
      source,
      Math.max(0, Math.min(source.length, placeholder.offset)),
      "after",
    );
    const current = grouped.get(offset);
    grouped.set(offset, {
      active: Boolean(current?.active || placeholder.active),
      mirror: Boolean(current?.mirror || placeholder.mirror),
    });
  }
  const caretOffset = selection
    ? visualTexPreviewSafeMarkerOffsetInSource(source, selection.head, "after")
    : null;
  return {
    // Preview metadata must never be injected into the TeX stream. In
    // particular, MathLive parses unknown commands as literal text while the
    // user is deleting an incomplete `\\text{...}` group. Caret and snippet
    // stops are drawn as host overlays after MathLive renders this exact value.
    latex: source,
    caretOffset,
    placeholders: [...grouped.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([offset, marker]) => ({ offset, ...marker })),
    sourceOffset(offset, _affinity = "after") {
      return Math.max(0, Math.min(source.length, offset));
    },
  };
}

type VisualTexSourceToken = { value: string; from: number; to: number };

/**
 * Split TeX source into the units a rendered formula can point back at.
 *
 * Every unit is kept, including whitespace and the structural `_`/`^`/braces,
 * because the alignment below decides what to skip by comparing against what
 * MathLive actually produced. Dropping units here is what previously made the
 * two sequences disagree on counts.
 */
function visualTexSourceTokens(source: string): VisualTexSourceToken[] {
  const tokens: VisualTexSourceToken[] = [];
  for (let position = 0; position < source.length;) {
    const from = position;
    const character = source[position]!;
    if (character === "\\") {
      position++;
      if (/[A-Za-z@]/.test(source[position] ?? "")) {
        while (position < source.length && /[A-Za-z@]/.test(source[position]!)) position++;
      } else if (position < source.length) {
        position += String.fromCodePoint(source.codePointAt(position)!).length;
      }
    } else {
      position += String.fromCodePoint(source.codePointAt(position)!).length;
    }
    tokens.push({ value: source.slice(from, position), from, to: position });
  }
  return tokens;
}

/**
 * The source unit a single MathLive atom stands for, or `null` when the atom is
 * pure structure.
 *
 * `getValue(p - 1, p, "latex")` serializes exactly one atom. Leaves come back as
 * their own literal source (`u`, `(`, `\in`, `\circ`), text-mode characters come
 * back wrapped in `\text{…}`, and every structural atom — a group boundary, the
 * `\bar` accent shell, the `\frac` shell, a `\left(…\right)` shell — comes back
 * as the empty string. That gives a leaf stream in source order, which is the
 * only faithful correspondence MathLive exposes: whole-value serialization is
 * verbatim but useless for offsets, and any *range* serialization rebuilds the
 * structures it partially covers (`_{i_a}` comes back as `_{i_{a}}`), which is
 * what the previous prefix-based mapping was trying to match against.
 */
function visualTexAtomLeafValue(atomLatex: string): string | null {
  const value = atomLatex.trim() === "" ? "" : atomLatex;
  if (!value) return null;
  const text = /^\\(?:text|textrm|textnormal|mbox)\{([\s\S]*)\}$/.exec(atomLatex);
  if (text) return text[1] ?? null;
  if (/^\\placeholder(\[[^\]]*\])?\{[\s\S]*\}$/.test(value)) return null;
  return value;
}

/**
 * How many source units a single leaf may skip past while looking for its own.
 * One leaf is preceded by at most a short run of structure (`\left\lfloor`,
 * `\frac`, `{`, `_`, `^`, whitespace); beyond that the leaf is treated as
 * MathLive-synthesized and inherits the previous boundary.
 */
const VISUAL_TEX_ALIGNMENT_LOOKAHEAD = 32;

/**
 * Atom count past which the exact per-atom index is not worth a frame. A very
 * large `align` environment would otherwise cost one serialization per atom on
 * every commit; beyond this the mapping degrades to a proportional estimate and
 * the overlay hides rather than stalling.
 */
const VISUAL_TEX_PREVIEW_INDEX_LIMIT = 1500;

type VisualTexPreviewPositionIndex = {
  source: string;
  lastOffset: number;
  /**
   * Source offset each MathLive position maps to, monotone non-decreasing.
   * Index `p` holds the end of the source unit rendered by the atom at `p`.
   * Empty when `degraded` is set.
   */
  sourceOffsetAt: number[];
  /** Formula too large to index exactly; positions fall back to a ratio. */
  degraded: boolean;
};

/**
 * Align MathLive's leaf-atom stream with the TeX source.
 *
 * Both sequences are in document order and every leaf is serialized as its own
 * literal source, so this is an exact match with skipping — never a similarity
 * score. A leaf only ever skips forward, which makes the whole map monotone:
 * clicking further right can never resolve further left.
 */
function buildVisualTexPreviewPositionIndex(
  field: MathfieldElement,
  latex: string,
): VisualTexPreviewPositionIndex {
  const source = normalizeVisualTexLatex(latex);
  if (field.lastOffset > VISUAL_TEX_PREVIEW_INDEX_LIMIT) {
    return { source, lastOffset: field.lastOffset, sourceOffsetAt: [], degraded: true };
  }
  const tokens = visualTexSourceTokens(source);
  const sourceOffsetAt: number[] = [0];
  let tokenIndex = 0;
  let matchedEnd = 0;
  for (let position = 1; position <= field.lastOffset; position++) {
    const leaf = visualTexAtomLeafValue(field.getValue(position - 1, position, "latex"));
    if (leaf !== null) {
      const limit = Math.min(tokens.length, tokenIndex + VISUAL_TEX_ALIGNMENT_LOOKAHEAD);
      for (let candidate = tokenIndex; candidate < limit; candidate++) {
        if (tokens[candidate]!.value === leaf) {
          matchedEnd = tokens[candidate]!.to;
          tokenIndex = candidate + 1;
          break;
        }
      }
    }
    sourceOffsetAt.push(matchedEnd);
  }
  return { source, lastOffset: field.lastOffset, sourceOffsetAt, degraded: false };
}

/** Source offset the caret sits at when MathLive is at `position`. */
function visualTexPreviewSourceOffsetFromIndex(
  index: VisualTexPreviewPositionIndex,
  position: number,
): number {
  if (position <= 0) return 0;
  if (position >= index.lastOffset) return index.source.length;
  if (index.degraded) {
    return visualTexPreviewSafeMarkerOffsetInSource(
      index.source,
      Math.round((position / index.lastOffset) * index.source.length),
      "after",
    );
  }
  return index.sourceOffsetAt[position] ?? 0;
}

function visualTexPreviewPositionFromIndex(
  index: VisualTexPreviewPositionIndex,
  sourceOffset: number,
): number {
  const { source, lastOffset, sourceOffsetAt } = index;
  const target = visualTexPreviewSafeMarkerOffsetInSource(source, sourceOffset, "after");
  if (lastOffset <= 0 || target <= 0) return 0;
  if (target >= source.length) return lastOffset;
  if (index.degraded) return Math.round((target / source.length) * lastOffset);
  // `sourceOffsetAt` is monotone: take the first position that has consumed the
  // source up to the caret.
  let low = 0;
  let high = lastOffset;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((sourceOffsetAt[mid] ?? 0) < target) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** Map a CM6 source boundary to the MathLive position rendering it. */
export function visualTexPreviewMathfieldPositionFromSourceOffset(
  field: MathfieldElement,
  latex: string,
  sourceOffset: number,
): number {
  return visualTexPreviewPositionFromIndex(
    buildVisualTexPreviewPositionIndex(field, latex),
    sourceOffset,
  );
}

/** Map a MathLive position back to the CM6 TeX boundary it renders. */
export function visualTexPreviewSourceOffsetFromMathfieldPosition(
  field: MathfieldElement,
  latex: string,
  position: number,
): number {
  return visualTexPreviewSourceOffsetFromIndex(
    buildVisualTexPreviewPositionIndex(field, latex),
    position,
  );
}

/**
 * `Mathfield.setValue()` defaults its insertion mode to whatever mode the
 * current caret position happens to be in. A formula that momentarily contains
 * an unterminated `\\text{` leaves that position in text mode, after which
 * every later assignment is inserted as literal characters — the whole LaTeX
 * source, backslashes and all, appears instead of a rendered formula, and the
 * field stays stuck that way. A read-only mirror must never inherit an editing
 * mode, so pin every assignment to math mode.
 */
export function setVisualTexPreviewValue(
  field: Pick<MathfieldElement, "setValue">,
  latex: string,
): void {
  field.setValue(latex, {
    mode: "math",
    format: "latex",
    selectionMode: "after",
    silenceNotifications: true,
  });
}

function visualTexSnippetRangeValue(
  field: MathfieldElement,
  marker: VisualTexSnippetMarkerRange,
): string {
  let result = stripVisualTexPlaceholders(normalizeVisualTexMathLiveOutput(
    normalizeVisualTexLatex(
      field.getValue(marker.range[0], marker.range[1], "latex-expanded"),
    ),
  ));
  const wrappers: string[] = [];
  if (marker.mode === "text") wrappers.push("text");
  const variant = marker.style?.variant;
  if (variant === "calligraphic") wrappers.push("mathcal");
  else if (variant === "sans-serif") wrappers.push("mathsf");
  else if (variant === "monospace") wrappers.push("mathtt");
  else if (variant === "double-struck") wrappers.push("mathbb");
  else if (variant === "fraktur") wrappers.push("mathfrak");
  if (marker.style?.fontSeries === "b") wrappers.push("mathbf");
  if (marker.style?.fontShape === "it") wrappers.push("mathit");

  for (let pass = 0; pass < wrappers.length; pass++) {
    const command = wrappers.find((candidate) => result.startsWith(`\\${candidate}{`));
    if (!command) break;
    const body = readDelimitedGroup(result, command.length + 1, "{", "}");
    if (!body || body.end !== result.length) break;
    result = body.body;
  }
  return result;
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
const VISUAL_TEX_SNIPPET_START_MACRO_NAME = "noemaMathSnippetStart";
const VISUAL_TEX_SNIPPET_END_MACRO_NAME = "noemaMathSnippetEnd";
const VISUAL_TEX_SNIPPET_MARKER_RE =
  /\\noemaMathSnippet(?:Start|End)(?![A-Za-z])[ \t]*\{[^{}]*\}[ \t]*/g;
const VISUAL_TEX_SOURCE_SPACE_MACRO: VisualTexMathLiveMacro = {
  def: "",
  args: 0,
  captureSelection: false,
  expand: false,
};
const VISUAL_TEX_SNIPPET_MARKER_MACRO: VisualTexMathLiveMacro = {
  def: "",
  args: 1,
  captureSelection: false,
  expand: false,
};
const visualTexLastSourceSpaceBoundary = new WeakMap<object, number>();

type VisualTexSnippetSession = {
  groups: VisualTexCompletionTemplate["tabstops"];
  anchors: Map<string, VisualTexSnippetAnchor>;
  /** MathLive offset immediately after the inserted snippet (`$0`). */
  finalPosition: number;
  /** Root size when the anchor was recorded; tabstop edits map it by this delta. */
  lastOffset: number;
};
type VisualTexSnippetAnchor = {
  left: VisualTexInternalMacroAtom;
  right: VisualTexInternalMacroAtom | null;
  mode?: MathfieldElement["mode"];
  style?: Record<string, unknown>;
};
type VisualTexSnippetField = Pick<
  MathfieldElement,
  "position" | "lastOffset" | "selection" | "getValue" | "insert"
>;

const visualTexSnippetSessions = new WeakMap<object, VisualTexSnippetSession[]>();
const visualTexSnippetMirrorSync = new WeakSet<object>();
const visualTexMacroArgumentTemplates = new WeakMap<object, string>();
const visualTexSnippetInsertAdapters = new WeakSet<object>();
const visualTexHistoryInputBridges = new WeakSet<object>();

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

function installVisualTexSnippetInsertAdapter(field: MathfieldElement): void {
  if (visualTexSnippetInsertAdapters.has(field) || typeof field.insert !== "function") return;
  const original = field.insert.bind(field);
  field.insert = ((value, options) => {
    const active = activeVisualTexTabstop(field);
    const style = active?.session.anchors.get(active.tabstopId)?.style;
    const inserted = original(value, !style || options?.style
      ? options
      : { ...options, style });
    const operation = (field as unknown as {
      _mathfield?: { undoManager?: { lastOp?: string } };
    })._mathfield?.undoManager?.lastOp;
    if (inserted && synchronizeVisualTexSnippetMirrors(field)) {
      replaceVisualTexLatestUndoSnapshot(field, operation);
    }
    return inserted;
  }) as MathfieldElement["insert"];
  visualTexSnippetInsertAdapters.add(field);
}

function installVisualTexHistoryInputBridge(field: MathfieldElement): void {
  if (visualTexHistoryInputBridges.has(field) || typeof field.addEventListener !== "function") return;
  field.addEventListener("undo-state-change", ((event: CustomEvent<{ type?: string }>) => {
    const type = event.detail?.type;
    if (type !== "undo" && type !== "redo") return;
    // Undo replaces MathLive's atom tree, invalidating object anchors. History
    // navigation therefore exits snippet mode; the restored content remains
    // ordinary TeX and the next completion starts a fresh session.
    visualTexSnippetSessions.delete(field);
    field.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      composed: true,
      inputType: type === "undo" ? "historyUndo" : "historyRedo",
    }));
  }) as EventListener);
  visualTexHistoryInputBridges.add(field);
}

function replaceVisualTexLatestUndoSnapshot(field: object, operation?: string): void {
  const controller = (field as {
    _mathfield?: VisualTexUndoController & {
      undoManager?: { lastOp?: string };
      popUndoStack?: () => void;
    };
  })._mathfield;
  const resolved = operation || controller?.undoManager?.lastOp;
  if (!resolved) return;
  controller?.popUndoStack?.();
  controller?.snapshot?.(resolved);
}

function registerVisualTexSnippetSession(
  field: MathfieldElement,
  tabstops: VisualTexCompletionTemplate["tabstops"],
): void {
  if (tabstops.length === 0) return;
  const beforeLastOffset = field.lastOffset;
  const beforeFinalPosition = field.position;
  const anchors = captureVisualTexSnippetAnchors(
    field,
    new Set(tabstops.flatMap((group) => group.occurrenceIds)),
  );
  const distanceFromEnd = Math.max(0, beforeLastOffset - beforeFinalPosition);
  const sessions = visualTexSnippetSessions.get(field) ?? [];
  sessions.push({
    groups: tabstops.map((group) => ({
      ...group,
      occurrenceIds: [...group.occurrenceIds],
    })),
    anchors,
    finalPosition: Math.max(0, field.lastOffset - distanceFromEnd),
    lastOffset: field.lastOffset,
  });
  visualTexSnippetSessions.set(field, sessions);
}

type VisualTexSnippetMarkerRange = {
  range: [number, number];
  mode?: MathfieldElement["mode"];
  style?: Record<string, unknown>;
};

function visualTexSnippetMarkerId(atom: VisualTexInternalMacroAtom): string | null {
  const source = atom.macroArgs ?? "";
  const open = source.indexOf("{");
  const argument = open >= 0 ? readDelimitedGroup(source, open, "{", "}") : null;
  const id = argument?.body ?? source;
  return id || null;
}

function visualTexSnippetAnchorRange(
  field: object,
  anchor: VisualTexSnippetAnchor,
): VisualTexSnippetMarkerRange | null {
  const model = (field as {
    _mathfield?: {
      model?: {
        lastOffset?: number;
        offsetOf?: (atom: VisualTexInternalMacroAtom) => number;
      };
    };
  })._mathfield?.model;
  if (!model || typeof model.offsetOf !== "function"
    || typeof model.lastOffset !== "number") return null;
  const from = model.offsetOf(anchor.left);
  const right = anchor.right ? model.offsetOf(anchor.right) : model.lastOffset + 1;
  if (!Number.isFinite(from) || !Number.isFinite(right) || from < 0 || right <= from) return null;
  return {
    range: [from, Math.max(from, right - 1)],
    mode: anchor.mode,
    style: anchor.style,
  };
}

function visualTexSnippetSessionRanges(field: object): Map<string, VisualTexSnippetMarkerRange> {
  const result = new Map<string, VisualTexSnippetMarkerRange>();
  for (const session of visualTexSnippetSessions.get(field) ?? []) {
    for (const [id, anchor] of session.anchors) {
      const range = visualTexSnippetAnchorRange(field, anchor);
      if (range) result.set(id, range);
    }
  }
  return result;
}

function captureVisualTexSnippetAnchors(
  field: object,
  ids: ReadonlySet<string>,
): Map<string, VisualTexSnippetAnchor> {
  const model = (field as {
    _mathfield?: {
      model?: {
        root?: VisualTexInternalMacroAtom;
        atoms?: VisualTexInternalMacroAtom[];
        offsetOf?: (atom: VisualTexInternalMacroAtom) => number;
      };
    };
  })._mathfield?.model;
  if (!model?.root || !model.atoms || typeof model.offsetOf !== "function") return new Map();

  const starts = new Map<string, VisualTexInternalMacroAtom>();
  const ends = new Map<string, VisualTexInternalMacroAtom>();
  const markerAtoms = new Set<VisualTexInternalMacroAtom>();
  const collectMarkerTree = (atom: VisualTexInternalMacroAtom): void => {
    markerAtoms.add(atom);
    for (const child of atom.children ?? []) markerAtoms.add(child);
  };
  for (const atom of model.atoms) {
    if (atom.type === "macro") {
      const id = visualTexSnippetMarkerId(atom);
      if (id && ids.has(id)
        && (atom.command === `\\${VISUAL_TEX_SNIPPET_START_MACRO_NAME}`
          || atom.command === `\\${VISUAL_TEX_SNIPPET_END_MACRO_NAME}`)) {
        collectMarkerTree(atom);
        if (atom.command === `\\${VISUAL_TEX_SNIPPET_START_MACRO_NAME}`) starts.set(id, atom);
        else ends.set(id, atom);
      }
    }
  }

  const atoms = model.atoms;
  const result = new Map<string, VisualTexSnippetAnchor>();
  for (const id of ids) {
    const start = starts.get(id);
    const end = ends.get(id);
    if (!start || !end) continue;
    const startOffset = model.offsetOf(start);
    const endOffset = model.offsetOf(end);
    const contentAtom = atoms.slice(startOffset + 1, endOffset)
      .find((atom) => !markerAtoms.has(atom) && atom.type !== "first");
    let left: VisualTexInternalMacroAtom | undefined;
    let right: VisualTexInternalMacroAtom | null = null;
    for (let offset = startOffset - 1; offset >= 0; offset--) {
      if (!markerAtoms.has(atoms[offset]!)) {
        left = atoms[offset]!;
        break;
      }
    }
    for (let offset = endOffset + 1; offset < atoms.length; offset++) {
      if (!markerAtoms.has(atoms[offset]!)) {
        right = atoms[offset]!;
        break;
      }
    }
    if (left) {
      const style = { ...contentAtom?.style, ...start.style };
      result.set(id, {
        left,
        right,
        mode: (contentAtom?.mode ?? start.mode) as MathfieldElement["mode"],
        // Symbols such as the empty-field square can carry an empty local
        // style even when their containing tabstop is calligraphic/bold/etc.
        // Preserve that inherited marker style when replacement text arrives.
        style: Object.keys(style).length > 0 ? style : undefined,
      });
    }
  }

  rememberVisualTexMacroMarkerTemplates(field, ids);
  withVisualTexUndoRecordingSuspended(field, () => {
    detachVisualTexSnippetMarkerAtoms(field);
    stripMountedVisualTexSnippetMacroArguments(field);
  });
  return result;
}

type VisualTexActiveTabstop = {
  session: VisualTexSnippetSession;
  groupIndex: number;
  tabstopId: string;
  range: [number, number];
};

function visualTexSnippetField(field: object): VisualTexSnippetField | null {
  const candidate = field as Partial<VisualTexSnippetField>;
  return typeof candidate.position === "number"
    && typeof candidate.lastOffset === "number"
    && Boolean(candidate.selection)
    && typeof candidate.getValue === "function"
    && typeof candidate.insert === "function"
    ? candidate as VisualTexSnippetField
    : null;
}

function activeVisualTexTabstop(field: object): VisualTexActiveTabstop | null {
  const snippetField = visualTexSnippetField(field);
  const sessions = visualTexSnippetSessions.get(field);
  if (!snippetField || !sessions?.length) return null;
  const markerRanges = visualTexSnippetSessionRanges(field);
  const selection = snippetField.selection.ranges[0];
  if (!selection) return null;
  const selectedFrom = Math.min(selection[0], selection[1]);
  const selectedTo = Math.max(selection[0], selection[1]);
  const candidates: VisualTexActiveTabstop[] = [];
  for (const session of [...sessions].reverse()) {
    for (let groupIndex = 0; groupIndex < session.groups.length; groupIndex++) {
      const group = session.groups[groupIndex]!;
      for (const tabstopId of group.occurrenceIds) {
        const marker = markerRanges.get(tabstopId);
        const range = marker?.range;
        if (!range) continue;
        const from = Math.min(range[0], range[1]);
        const to = Math.max(range[0], range[1]);
        const exact = selectedFrom === from && selectedTo === to;
        const containsCaret = selectedFrom === selectedTo
          && snippetField.position >= from
          && snippetField.position <= to;
        if (exact || containsCaret) {
          candidates.push({ session, groupIndex, tabstopId, range: [from, to] });
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

function selectVisualTexTabstop(field: object, id: string): boolean {
  const snippetField = visualTexSnippetField(field);
  if (!snippetField) return false;
  const marker = visualTexSnippetSessionRanges(field).get(id);
  const range = marker?.range;
  if (!range) return false;
  const tabstopMode = marker.mode;
  withVisualTexUndoRecordingSuspended(field, () => {
    snippetField.selection = { ranges: [[range[0], range[1]]], direction: "forward" };
    // A non-collapsed selection does not reliably make MathLive switch its
    // model mode. Without this, a text tabstop followed by math receives
    // `$ x $` instead of a real text `x` even though it is visibly inside
    // `\\text{...}`.
    const modeField = field as Partial<Pick<MathfieldElement, "mode">>;
    if (tabstopMode && modeField.mode !== tabstopMode) modeField.mode = tabstopMode;
  });
  // Assigning MathfieldElement.selection directly does not call MathLive's
  // command-layer coalescing barrier. A structural tabstop move should split
  // the surrounding typing into distinct, predictable undo steps.
  stopVisualTexUndoCoalescing(field);
  return true;
}

function visualTexSnippetMarker(command: "start" | "end", id: string): string {
  const name = command === "start"
    ? VISUAL_TEX_SNIPPET_START_MACRO_NAME
    : VISUAL_TEX_SNIPPET_END_MACRO_NAME;
  return `\\${name}{${id}}`;
}

/** Convert the template's transient placeholder notation to zero-width boundaries. */
function visualTexSnippetTemplateMarkers(
  source: string,
  occurrenceIds: ReadonlySet<string>,
): string {
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
        const id = options[0]?.body ?? "";
        const content = visualTexSnippetTemplateMarkers(body.body, occurrenceIds);
        if (id && occurrenceIds.has(id)) {
          result += `${visualTexSnippetMarker("start", id)}${content}`
            + visualTexSnippetMarker("end", id);
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

function stripVisualTexSnippetMarkers(
  source: string,
  occurrenceIds?: ReadonlySet<string>,
): string {
  return source.replace(VISUAL_TEX_SNIPPET_MARKER_RE, (marker) => {
    if (!occurrenceIds) return "";
    const open = marker.indexOf("{");
    const argument = open >= 0 ? readDelimitedGroup(marker, open, "{", "}") : null;
    return argument && occurrenceIds.has(argument.body) ? "" : marker;
  });
}

function finishVisualTexSnippetSession(
  field: VisualTexSnippetField,
  session: VisualTexSnippetSession,
  mappedFinal: number,
): number {
  const sessions = visualTexSnippetSessions.get(field as object) ?? [];
  synchronizeVisualTexSnippetMirrors(field as object);
  synchronizeVisualTexMacroTabstopArguments(field as object);
  const completedIds = new Set(session.groups.flatMap((group) => group.occurrenceIds));
  retireVisualTexMacroMarkerTemplates(field as object, completedIds);
  visualTexSnippetSessions.set(
    field as object,
    sessions.filter((candidate) => candidate !== session),
  );
  return Math.max(0, Math.min(mappedFinal, field.lastOffset));
}

/**
 * A mouse click or ordinary arrow can leave every registered tabstop without
 * traversing Noema's explicit navigation command. Retire those abandoned
 * sessions before the next structural action.
 */
function finishInactiveVisualTexTabstopSessions(field: object): boolean {
  if (activeVisualTexTabstop(field)) return false;
  const snippetField = visualTexSnippetField(field);
  const sessions = visualTexSnippetSessions.get(field);
  const selection = snippetField?.selection.ranges[0];
  if (!snippetField || !sessions?.length || !selection
      || snippetField.selection.ranges.length !== 1 || selection[0] !== selection[1]) return false;

  let mappedPosition = snippetField.position;
  for (const session of [...sessions].reverse()) {
    mappedPosition = finishVisualTexSnippetSession(
      snippetField,
      session,
      mappedPosition,
    );
  }
  withVisualTexUndoRecordingSuspended(field, () => {
    snippetField.selection = {
      ranges: [[mappedPosition, mappedPosition]],
      direction: "forward",
    };
  });
  stopVisualTexUndoCoalescing(field);
  return true;
}

function finishAllVisualTexSnippetSessions(field: object): boolean {
  const snippetField = visualTexSnippetField(field);
  const sessions = visualTexSnippetSessions.get(field);
  if (!snippetField || !sessions?.length) return false;
  let mappedPosition = snippetField.position;
  for (const session of [...sessions].reverse()) {
    mappedPosition = finishVisualTexSnippetSession(snippetField, session, mappedPosition);
  }
  withVisualTexUndoRecordingSuspended(field, () => {
    snippetField.selection = {
      ranges: [[mappedPosition, mappedPosition]],
      direction: "forward",
    };
  });
  stopVisualTexUndoCoalescing(field);
  return true;
}

export function selectAllVisualTexMathfield(field: MathfieldElement): void {
  // Selecting the whole formula explicitly leaves snippet-entry mode.
  finishAllVisualTexSnippetSessions(field);
  withVisualTexUndoRecordingSuspended(field, () => {
    field.executeCommand("selectAll");
  });
}

function moveVisualTexTabstopSession(
  field: object,
  backward: boolean,
): "moved" | "final" | "exhausted" | "none" {
  const active = activeVisualTexTabstop(field);
  if (!active) return "none";
  const step = backward ? -1 : 1;
  for (let index = active.groupIndex + step;
    index >= 0 && index < active.session.groups.length;
    index += step) {
    if (selectVisualTexTabstop(field, active.session.groups[index]!.primaryId)) return "moved";
  }
  if (!backward) {
    const snippetField = visualTexSnippetField(field);
    if (!snippetField) return "exhausted";
    const mappedFinal = Math.max(0, Math.min(
      active.session.finalPosition + (snippetField.lastOffset - active.session.lastOffset),
      snippetField.lastOffset,
    ));
    const finalPosition = finishVisualTexSnippetSession(
      snippetField,
      active.session,
      mappedFinal,
    );
    withVisualTexUndoRecordingSuspended(field, () => {
      snippetField.selection = { ranges: [[finalPosition, finalPosition]], direction: "forward" };
    });
    stopVisualTexUndoCoalescing(field);
    return "final";
  }
  return "exhausted";
}

function synchronizeVisualTexSnippetMirrors(field: object): boolean {
  const snippetField = visualTexSnippetField(field);
  const active = activeVisualTexTabstop(field);
  if (!snippetField || !active || visualTexSnippetMirrorSync.has(field)) return false;
  const group = active.session.groups[active.groupIndex]!;
  if (group.occurrenceIds.length < 2) return false;
  const markerRanges = visualTexSnippetSessionRanges(field);
  const activeMarker = markerRanges.get(active.tabstopId);
  if (!activeMarker) return false;
  const value = visualTexSnippetRangeValue(snippetField as MathfieldElement, activeMarker);
  const savedSelection = {
    ranges: snippetField.selection.ranges.map(([from, to]) => [from, to] as [number, number]),
    direction: snippetField.selection.direction,
  };
  let changed = false;
  visualTexSnippetMirrorSync.add(field);
  try {
    // Mirrors are one logical user edit. Updating duplicate occurrences must
    // not add extra undo entries or make the first Cmd-Z change only a mirror.
    withVisualTexUndoRecordingSuspended(field, () => {
      for (const id of group.occurrenceIds) {
        if (id === active.tabstopId) continue;
        const marker = visualTexSnippetSessionRanges(field).get(id);
        if (marker) {
          const mirrorValue = visualTexSnippetRangeValue(snippetField as MathfieldElement, marker);
          if (mirrorValue === value) continue;
          selectVisualTexTabstop(field, id);
          snippetField.insert(value, {
            format: "latex",
            insertionMode: "replaceSelection",
            selectionMode: "after",
            focus: false,
            feedback: false,
            scrollIntoView: false,
            silenceNotifications: true,
          });
          changed = true;
        }
      }
    });
    if (!selectVisualTexTabstop(field, active.tabstopId)) {
      withVisualTexUndoRecordingSuspended(field, () => { snippetField.selection = savedSelection; });
    }
  } finally {
    visualTexSnippetMirrorSync.delete(field);
  }
  return changed;
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
  value?: string;
  mode?: string;
  style?: Record<string, unknown>;
  command?: string;
  macroArgs?: string;
  parent?: VisualTexInternalMacroAtom;
  parentBranch?: string | [number, number];
  isDirty?: boolean;
  children?: VisualTexInternalMacroAtom[];
  branches?: string[];
  branch?: (name: string | [number, number]) => VisualTexInternalMacroAtom[] | undefined;
};

function detachVisualTexMacroAtoms(field: object, macroName: string): number {
  const atoms = (field as {
    _mathfield?: { model?: { atoms?: VisualTexInternalMacroAtom[] } };
  })._mathfield?.model?.atoms;
  if (!atoms) return 0;
  let removed = 0;
  for (const atom of [...atoms].reverse()) {
    if (atom.type !== "macro" || atom.command !== `\\${macroName}`) continue;
    const parent = atom.parent;
    const branch = atom.parentBranch;
    const siblings = parent && branch !== undefined ? parent.branch?.(branch) : undefined;
    const index = siblings?.indexOf(atom) ?? -1;
    if (!siblings || index < 0) continue;
    siblings.splice(index, 1);
    atom.parent = undefined;
    atom.parentBranch = undefined;
    atom.isDirty = true;
    parent!.isDirty = true;
    removed++;
  }
  return removed;
}

function detachVisualTexSnippetMarkerAtoms(field: object): number {
  return detachVisualTexMacroAtoms(field, VISUAL_TEX_SNIPPET_START_MACRO_NAME)
    + detachVisualTexMacroAtoms(field, VISUAL_TEX_SNIPPET_END_MACRO_NAME);
}

function rememberVisualTexMacroMarkerTemplates(
  field: object,
  ids: ReadonlySet<string>,
): void {
  const atoms = (field as {
    _mathfield?: { model?: { atoms?: VisualTexInternalMacroAtom[] } };
  })._mathfield?.model?.atoms;
  if (!atoms) return;
  for (const atom of atoms) {
    if (atom.type === "macro"
      && typeof atom.macroArgs === "string"
      && atom.macroArgs.includes(`\\${VISUAL_TEX_SNIPPET_START_MACRO_NAME}`)
      && [...ids].some((id) => atom.macroArgs!.includes(`{${id}}`))) {
      visualTexMacroArgumentTemplates.set(atom, atom.macroArgs);
    }
  }
}

function stripMountedVisualTexSnippetMacroArguments(field: object): void {
  const atoms = (field as {
    _mathfield?: { model?: { atoms?: VisualTexInternalMacroAtom[] } };
  })._mathfield?.model?.atoms;
  if (!atoms) return;
  for (const atom of atoms) {
    if (atom.type === "macro"
      && typeof atom.macroArgs === "string"
      && atom.macroArgs.includes("\\noemaMathSnippet")) {
      atom.macroArgs = stripVisualTexSnippetMarkers(atom.macroArgs);
      atom.isDirty = true;
    }
  }
}

function retireVisualTexMacroMarkerTemplates(
  field: object,
  ids: ReadonlySet<string>,
): void {
  const atoms = (field as {
    _mathfield?: { model?: { atoms?: VisualTexInternalMacroAtom[] } };
  })._mathfield?.model?.atoms;
  if (!atoms) return;
  for (const atom of atoms) {
    const template = visualTexMacroArgumentTemplates.get(atom);
    if (template && [...ids].some((id) => template.includes(`{${id}}`))) {
      visualTexMacroArgumentTemplates.delete(atom);
    }
  }
}

type VisualTexSnippetSourceMarker = {
  kind: "start" | "end";
  id: string;
  start: number;
  end: number;
};

function readVisualTexSnippetSourceMarker(
  source: string,
  index: number,
): VisualTexSnippetSourceMarker | null {
  const commands: Array<["start" | "end", string]> = [
    ["start", `\\${VISUAL_TEX_SNIPPET_START_MACRO_NAME}`],
    ["end", `\\${VISUAL_TEX_SNIPPET_END_MACRO_NAME}`],
  ];
  for (const [kind, command] of commands) {
    if (!source.startsWith(command, index)
      || /[A-Za-z]/.test(source[index + command.length] ?? "")) continue;
    let cursor = index + command.length;
    while (source[cursor] === " " || source[cursor] === "\t") cursor++;
    const argument = readDelimitedGroup(source, cursor, "{", "}");
    if (argument) return { kind, id: argument.body, start: index, end: argument.end };
  }
  return null;
}

function resolveVisualTexSnippetMarkerArgumentTemplate(
  source: string,
  field: MathfieldElement,
  ranges: ReadonlyMap<string, VisualTexSnippetMarkerRange>,
): string {
  let result = "";
  for (let index = 0; index < source.length;) {
    const marker = readVisualTexSnippetSourceMarker(source, index);
    if (!marker || marker.kind !== "start") {
      result += source[index]!;
      index++;
      continue;
    }

    let cursor = marker.end;
    let endMarker: VisualTexSnippetSourceMarker | null = null;
    while (cursor < source.length) {
      const candidate = readVisualTexSnippetSourceMarker(source, cursor);
      if (candidate?.kind === "end" && candidate.id === marker.id) {
        endMarker = candidate;
        break;
      }
      cursor = candidate?.end ?? cursor + 1;
    }
    if (!endMarker) {
      result += source.slice(marker.start, marker.end);
      index = marker.end;
      continue;
    }

    const range = ranges.get(marker.id)?.range;
    const content = range
      ? normalizeVisualTexLatex(field.getValue(range[0], range[1], "latex-expanded"))
      : resolveVisualTexSnippetMarkerArgumentTemplate(
        source.slice(marker.end, endMarker.start),
        field,
        ranges,
      );
    result += source.slice(marker.start, marker.end)
      + content
      + source.slice(endMarker.start, endMarker.end);
    index = endMarker.end;
  }
  return result;
}

/**
 * MathLive keeps a MacroAtom's original argument source immutable while its
 * expanded atoms are edited. Refresh that source from logical tabstop ranges
 * so `\\bra{...}`/`\\braket{...}` remain compact instead of falling back to
 * their `\\left...\\middle...` expansion.
 */
function synchronizeVisualTexMacroTabstopArguments(field: object): void {
  const atoms = (field as {
    _mathfield?: { model?: { atoms?: VisualTexInternalMacroAtom[] } };
  })._mathfield?.model?.atoms;
  if (!atoms) return;
  const markerRanges = visualTexSnippetSessionRanges(field);

  for (const atom of atoms) {
    if (atom.type === "macro" && typeof atom.macroArgs === "string") {
      const template = visualTexMacroArgumentTemplates.get(atom);
      if (template) {
        atom.macroArgs = stripVisualTexSnippetMarkers(
          resolveVisualTexSnippetMarkerArgumentTemplate(
            template,
            field as MathfieldElement,
            markerRanges,
          ),
        );
      }
    }
  }
}

/** Remove imported MathLive placeholder commands and its insertion-only `#?` marker. */
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
    .replace(VISUAL_TEX_SNIPPET_MARKER_RE, "")
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
  // A mirror never receives input, so the snippet/undo machinery below is dead
  // weight on it — and monkey-patching `field.insert` on a field nobody types
  // into only widens the surface for a MathLive render to fail.
  options: { readOnlyMirror?: boolean } = {},
): void {
  visualTexLastSourceSpaceBoundary.delete(field as object);
  visualTexSnippetSessions.delete(field as object);
  visualTexMathfieldSerializationStates.delete(field as object);
  if (!options.readOnlyMirror) {
    installVisualTexSnippetInsertAdapter(field as MathfieldElement);
    installVisualTexHistoryInputBridge(field as MathfieldElement);
  }
  field.macros = {
    ...visualTexMathLiveMacros(macros),
    [VISUAL_TEX_SOURCE_SPACE_MACRO_NAME]: VISUAL_TEX_SOURCE_SPACE_MACRO,
    [VISUAL_TEX_SNIPPET_START_MACRO_NAME]: VISUAL_TEX_SNIPPET_MARKER_MACRO,
    [VISUAL_TEX_SNIPPET_END_MACRO_NAME]: VISUAL_TEX_SNIPPET_MARKER_MACRO,
  };
  // `mode` is deliberate: without it MathLive inherits the mode of whatever
  // position the field's caret currently sits in, which turns a reused field
  // into a literal-text renderer once a `\text{` group has been open.
  field.setValue(normalizeVisualTexLatex(latex), { mode: "math", selectionMode: "after" });
  if (options.readOnlyMirror) return;
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
  finishInactiveVisualTexTabstopSessions(field);
  // MathLive keeps an unfinished backslash command in a transient editor.
  // Replacing that range directly reports success but leaves the completion
  // inside command mode, so neither Enter nor Space visibly accepts it.
  // Materialize the command as a normal math atom before replacing its range.
  let acceptedCommand = false;
  if (field.mode === "latex") {
    withVisualTexUndoRecordingSuspended(field, () => {
      acceptedCommand = field.executeCommand(["complete", "accept-all"]);
    });
    if (acceptedCommand) snapshotVisualTexUndoState(field, "complete-command");
  }
  const suffix = prefix.slice(Math.max(0, prefix.length - deleteBefore));
  const range = suffixRange(field, suffix);
  if (!range) return false;
  withVisualTexUndoRecordingSuspended(field, () => {
    field.selection = { ranges: [range] };
  });
  const registeredOccurrenceIds = typeof template === "string"
    ? []
    : template.tabstops.flatMap((group) => group.occurrenceIds);
  let templateLatex = typeof template === "string"
    ? template
    : visualTexSnippetTemplateMarkers(template.latex, new Set(registeredOccurrenceIds));
  if (typeof template !== "string" && template.needsFinalSourceBoundary) {
    templateLatex += VISUAL_TEX_SOURCE_SPACE_MARKER;
  }
  let inserted = false;
  const insertTemplate = (): void => {
    inserted = field.insert(templateLatex, {
      format: "latex",
      insertionMode: "replaceSelection",
      selectionMode: typeof template === "string" ? "placeholder" : "after",
      focus: false,
      feedback: false,
      scrollIntoView: false,
    });
    if (inserted && typeof template !== "string") {
      registerVisualTexSnippetSession(field, template.tabstops);
    }
  };
  if (typeof template === "string") insertTemplate();
  else withVisualTexUndoRecordingSuspended(field, insertTemplate);
  if (!inserted) return false;
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
  snapshotVisualTexUndoState(field, "insert-snippet");
  const first = [...template.tabstops].sort((a, b) => a.index - b.index)[0];
  if (first) selectVisualTexTabstop(field, first.primaryId);
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
  const inserted = field.executeCommand(["typedText", text, {
    focus: false,
    feedback: false,
    simulateKeystroke: true,
  }]);
  const operation = (field as unknown as {
    _mathfield?: { undoManager?: { lastOp?: string } };
  })._mathfield?.undoManager?.lastOp;
  if (inserted && synchronizeVisualTexSnippetMirrors(field)) {
    replaceVisualTexLatestUndoSnapshot(field, operation);
  }
  return inserted;
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
  finishInactiveVisualTexTabstopSessions(field);
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

type VisualTexAtomScope = {
  parent: VisualTexInternalMacroAtom;
  branch: string | [number, number] | undefined;
};

function sameVisualTexAtomBranch(
  left: VisualTexAtomScope["branch"],
  right: VisualTexAtomScope["branch"],
): boolean {
  if (!Array.isArray(left) || !Array.isArray(right)) return left === right;
  return left[0] === right[0] && left[1] === right[1];
}

function visualTexAtomScopePath(atom: VisualTexInternalMacroAtom | undefined): VisualTexAtomScope[] {
  const path: VisualTexAtomScope[] = [];
  let child = atom;
  while (child?.parent) {
    path.push({ parent: child.parent, branch: child.parentBranch });
    child = child.parent;
  }
  return path.reverse();
}

function visualTexCommonScopeDepth(
  left: readonly VisualTexAtomScope[],
  right: readonly VisualTexAtomScope[],
): number {
  let depth = 0;
  while (depth < left.length && depth < right.length
      && left[depth]!.parent === right[depth]!.parent
      && sameVisualTexAtomBranch(left[depth]!.branch, right[depth]!.branch)) depth++;
  return depth;
}

/**
 * Recover an empty snippet field after its stronger object anchors are gone.
 * The square is ordinary formula content, so rank candidates by their shared
 * parent/branch path before distance; matrix cells and nested TeX branches do
 * not collapse into one flat search order. There is deliberately no wrapping.
 */
function selectVisualTexEmptyTabstopFallback(
  field: VisualTexNavigationField,
  backward: boolean,
): boolean {
  const model = (field as unknown as {
    _mathfield?: { model?: { atoms?: VisualTexInternalMacroAtom[] } };
  })._mathfield?.model;
  const atoms = model?.atoms;
  const selection = field.selection.ranges[0];
  if (!atoms || !selection || field.selection.ranges.length !== 1) return false;

  const selectedFrom = Math.min(selection[0], selection[1]);
  const selectedTo = Math.max(selection[0], selection[1]);
  const origin = backward ? selectedFrom : selectedTo;
  const selected = selectedFrom !== selectedTo;
  const originOffset = Math.max(0, Math.min(
    atoms.length - 1,
    selected && backward ? selectedFrom + 1 : field.position,
  ));
  const originPath = visualTexAtomScopePath(atoms[originOffset]);
  const candidates = atoms.flatMap((atom, offset) => {
    if (offset <= 0 || (atom.value !== "□" && atom.command !== "\\square")) return [];
    const from = offset - 1;
    const to = offset;
    if (from === selectedFrom && to === selectedTo) return [];
    if (backward ? to > origin : from < origin) return [];
    return [{
      atom,
      from,
      to,
      scopeDepth: visualTexCommonScopeDepth(originPath, visualTexAtomScopePath(atom)),
      distance: backward ? origin - to : from - origin,
    }];
  }).sort((left, right) => (
    right.scopeDepth - left.scopeDepth
    || left.distance - right.distance
    || (backward ? right.from - left.from : left.from - right.from)
  ));
  const target = candidates[0];
  if (!target) return false;

  withVisualTexUndoRecordingSuspended(field as object, () => {
    field.selection = {
      ranges: [[target.from, target.to]],
      direction: backward ? "backward" : "forward",
    };
    const modeField = field as VisualTexNavigationField & Partial<Pick<MathfieldElement, "mode">>;
    if (target.atom.mode && modeField.mode !== target.atom.mode) {
      modeField.mode = target.atom.mode as MathfieldElement["mode"];
    }
  });
  stopVisualTexUndoCoalescing(field as object);
  return true;
}

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

/** Normalize host/browser key aliases before MathLive sees printable input. */
export function visualTexMathfieldTypedText(key: VisualTexMathHostKey): string {
  // Backslash is TeX's command introducer. Some xwidget/host paths report the
  // physical key name instead of its text; letting that fall through makes
  // MathLive insert a visible backslash atom and leaves commands untypeable.
  if (key.key === "\\" || /^backslash$/i.test(key.key)
    || (key.code === "Backslash" && !key.shiftKey && (!key.key || key.key === "Unidentified"))) {
    return "\\";
  }
  if (typeof key.text === "string") return key.text;
  return key.key.length === 1 ? key.key : "";
}

export function visualTexMathBottomLeftInsets(
  field: { top: number; bottom: number },
  visual: { top: number; bottom: number },
): { top: number; bottom: number } {
  // The lower-left corner is the stable origin. MathLive's own box already
  // includes TeX depth, so the lower edge must never be recomputed from child
  // boxes. Additional formula ascent is absorbed above the field only. Do not
  // add permanent "safety" pixels: they made every active inline formula's
  // line box taller than the equivalent static KaTeX span.
  const overflowTop = Math.max(0, field.top - visual.top);
  return {
    top: Math.ceil(overflowTop),
    bottom: 0,
  };
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
    finishInactiveVisualTexTabstopSessions(field);
    closeCompletion(host);
    return "handled";
  }
  const deletion = visualTexMathfieldDeletionCommand(key);
  if (deletion) {
    finishInactiveVisualTexTabstopSessions(field);
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
  const text = visualTexMathfieldTypedText({ ...key, key: normalized });
  if (text) {
    finishInactiveVisualTexTabstopSessions(field);
    typedText(field, text);
    refreshCompletion(host, field);
    return "handled";
  }
  return "continue";
}

type VisualTexTabstopMove = "placeholder" | "snippet-boundary" | "edge" | "boundary";

function moveVisualTexTabstop(field: MathfieldElement, backward: boolean): VisualTexTabstopMove {
  const registered = moveVisualTexTabstopSession(field, backward);
  if (registered === "moved") return "placeholder";
  if (registered === "final") return "edge";
  // A live snippet never wraps and never falls through into TeX structure.
  // In particular, Cmd-[ at its first field is a consumed no-op that keeps the
  // session alive for the following forward move.
  if (registered === "exhausted") return "snippet-boundary";
  finishInactiveVisualTexTabstopSessions(field);
  // MathLive's native placeholder traversal is intentionally not a fallback:
  // Noema's logical tabstops are the sole snippet state, and the native command
  // wraps at the root, making Tab/Cmd-] jump back to the first formula atom.
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
 *   1. a command that starts at the root edge stays at that edge;
 *   2. otherwise visit the next/previous unresolved MathLive slot;
 *   3. with no slot, leave the nearest enclosing TeX parent (`}` boundary);
 *   4. with no enclosing parent, move to the root edge;
 *   5. later commands remain clamped there unless an outer source snippet
 *      explicitly accepts a boundary handoff.
 */
export type VisualTexNavigationStep =
  | "placeholder"
  | "snippet-boundary"
  | "final"
  | "parent"
  | "edge"
  | "boundary";

function keepVisualTexNavigationDirectional(
  field: VisualTexNavigationField,
  backward: boolean,
  origin: number,
  step: VisualTexNavigationStep,
): VisualTexNavigationStep {
  // Completing a logical tabstop session may remap its `$0` as edits change
  // the atom count. Keep the requested direction stable across that move.
  if (step === "boundary" || step === "snippet-boundary" || step === "final") return step;
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
  // MathLive represents natural-text parents (`\text`, `\operatorname`,
  // `\textrm`, `\textsf`, and their siblings) as text-atom runs rather than
  // addressable groups, so moveAfterParent alone cannot leave them reliably.
  for (let count = 0; count <= field.lastOffset + 1; count++) {
    if (modeField.getValue) {
      const from = backward ? Math.max(0, field.position - 1) : field.position;
      const to = backward ? field.position : Math.min(field.lastOffset, field.position + 1);
      const atom = modeField.getValue(from, to, "latex");
      if (!visualTexNaturalTextParentPattern.test(atom)) break;
    }
    const before = visualTexSelectionKey(field);
    withVisualTexUndoRecordingSuspended(field as object, () => {
      field.executeCommand(backward ? "moveToPreviousChar" : "moveToNextChar");
    });
    if (visualTexSelectionKey(field) === before) break;
    moved = true;
    if (modeField.mode !== "text") break;
  }
  if (moved && modeField.mode === "text") {
    withVisualTexUndoRecordingSuspended(field as object, () => {
      field.executeCommand(backward ? "moveBeforeParent" : "moveAfterParent");
    });
    if (modeField.mode === "text") modeField.mode = "math";
  }
  return moved;
}

const visualTexNaturalTextParentPattern =
  /^\\(?:operatorname\*?|text(?:bf|md|it|up|normal|rm|sf|tt)?|[hm]box)\{/;

function moveVisualTexPastNaturalTextParent(
  field: VisualTexNavigationField,
  backward: boolean,
): boolean {
  const inspectable = field as VisualTexNavigationField & Pick<
    MathfieldElement,
    "getElementInfo" | "getValue"
  >;
  const depth = inspectable.getElementInfo(field.position)?.depth ?? 0;
  if (depth <= 0) return false;

  let from = field.position;
  while (from > 0 && (inspectable.getElementInfo(from)?.depth ?? 0) >= depth) from--;
  let to = field.position;
  while (to < field.lastOffset
    && (inspectable.getElementInfo(to)?.depth ?? 0) >= depth) to++;
  if (from === to) return false;
  const latex = inspectable.getValue(from, to, "latex").trimStart();
  if (!visualTexNaturalTextParentPattern.test(latex)) return false;

  withVisualTexUndoRecordingSuspended(field as object, () => {
    field.position = backward ? from : to;
  });
  return true;
}

function leaveVisualTexTextParentAtRootBoundary(
  field: VisualTexNavigationField,
  backward: boolean,
): boolean {
  const modeField = field as VisualTexNavigationField & Pick<MathfieldElement, "mode">;
  if (modeField.mode !== "text" || !collapsedAtMathfieldBoundary(field, backward)) return false;
  const before = visualTexSelectionKey(field);
  withVisualTexUndoRecordingSuspended(field as object, () => {
    field.executeCommand(backward ? "moveBeforeParent" : "moveAfterParent");
  });
  if (modeField.mode !== "text" || visualTexSelectionKey(field) !== before) return true;

  // MathLive flattens a trailing natural-text run onto the root's final offset.
  // At that exact address moveAfterParent can report success without changing
  // the selection path. Switching the insertion mode is the missing structural
  // transition: subsequent math atoms are then created outside the text parent
  // while the caret remains at the same visual edge.
  modeField.mode = "math";
  return String(modeField.mode) !== "text";
}

export function advanceVisualTexNavigation(
  field: VisualTexNavigationField,
  backward: boolean,
): VisualTexNavigationStep {
  const origin = field.position;
  const finish = (step: VisualTexNavigationStep): VisualTexNavigationStep => (
    keepVisualTexNavigationDirectional(field, backward, origin, step)
  );
  const registered = moveVisualTexTabstopSession(field as object, backward);
  // Numeric tabstop order is semantic, not monotonic in MathLive's flattened
  // atom offsets: an outer default can intentionally precede its nested child.
  if (registered === "moved") return "placeholder";
  if (registered === "final") return finish("final");
  if (registered === "exhausted") return "snippet-boundary";
  if (registered === "none") {
    const sessions = visualTexSnippetSessions.get(field as object);
    const hasUsableAnchor = visualTexSnippetSessionRanges(field as object).size > 0;
    // A live logical session always wins. Only formulas with no session, or a
    // session whose atom identities have all gone stale, may use glyph recovery.
    if ((!sessions?.length || !hasUsableAnchor)
      && selectVisualTexEmptyTabstopFallback(field, backward)) return "placeholder";
    finishInactiveVisualTexTabstopSessions(field as object);
  }
  if (collapsedAtMathfieldBoundary(field, backward)) {
    if (leaveVisualTexTextParentAtRootBoundary(field, backward)) return "parent";
    return "boundary";
  }

  if (moveVisualTexPastTextRun(field, backward)) {
    return finish("parent");
  }
  if (moveVisualTexPastNaturalTextParent(field, backward)) {
    return finish("parent");
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
  // Enter is a structural edit and explicitly ends live snippet navigation
  // before taking the source split.
  finishAllVisualTexSnippetSessions(field);
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

function installVisualTexPreviewShadowStyles(field: MathfieldElement): void {
  const root = field.shadowRoot;
  if (!root || root.querySelector("style[data-noema-livetex-preview]")) return;
  const style = document.createElement("style");
  style.dataset.noemaLivetexPreview = "true";
  style.textContent = `
    [part='placeholder'],
    .ML__placeholder {
      min-width: 0.58em;
      border-radius: 2px;
      outline: 1px dashed rgb(130 184 214 / 62%);
      background: rgb(130 184 214 / 13%);
    }
    [data-noema-preview-active='true'] [part='placeholder'],
    [data-noema-preview-active='true'].ML__placeholder,
    [data-noema-preview-active='true'] .ML__placeholder {
      outline: 1px solid rgb(239 91 135 / 85%);
      background: rgb(239 91 135 / 20%);
    }
  `;
  root.append(style);
}

type VisualTexPreviewOverlayGeometry = {
  left: number;
  top: number;
  height: number;
};

/**
 * `hostRect` is passed in rather than read here: this runs once per snippet
 * stop plus once for the caret, and reading the host's box inside the loop cost
 * a forced layout per marker.
 */
function visualTexPreviewOverlayGeometry(
  field: MathfieldElement,
  hostRect: DOMRect,
  sourceOffset: number,
  positionIndex: VisualTexPreviewPositionIndex,
): VisualTexPreviewOverlayGeometry | null {
  if (positionIndex.degraded) return null;
  if (field.lastOffset <= 0) {
    const fieldRect = field.getBoundingClientRect();
    return {
      left: fieldRect.left - hostRect.left,
      top: fieldRect.top - hostRect.top,
      height: Math.max(12, fieldRect.height),
    };
  }
  const target = Math.max(0, Math.min(positionIndex.source.length, sourceOffset));
  const position = visualTexPreviewPositionFromIndex(positionIndex, target);
  const infoPosition = position <= 0 ? 1 : Math.min(field.lastOffset, position);
  const info = field.getElementInfo(infoPosition);
  const bounds = info?.bounds;
  if (!bounds) return null;
  const mappedSourceOffset = visualTexPreviewSourceOffsetFromIndex(positionIndex, position);
  return {
    // A serialized prefix longer than the requested source prefix means the
    // nearest MathLive atom lies after the CM6 caret (not before it).
    left: (position <= 0 || mappedSourceOffset > target ? bounds.left : bounds.right) - hostRect.left,
    top: bounds.top - hostRect.top,
    height: Math.max(12, bounds.height),
  };
}

/**
 * Trailing merge for source→MathLive synchronization. Short on purpose: after
 * the O(n) alignment index replaced the old O(n²) one, a single commit is
 * cheap, so this only needs to collapse a burst of keystrokes.
 */
const VISUAL_TEX_PREVIEW_SYNC_MS = 40;

let visualTexPreviewRecoveries = 0;

/**
 * How many times a preview commit failed verification and had to be re-applied
 * or rebuilt. Ordinary editing must never increment this; tests assert that.
 */
export function visualTexPreviewRecoveryCount(): number {
  return visualTexPreviewRecoveries;
}

/** A focus-free MathLive mirror for the CM6 source caret and snippet fields. */
export function mountVisualTexPreview(
  host: HTMLElement,
  options: VisualTexPreviewOptions,
): VisualTexPreview {
  let destroyed = false;
  let suspended = false;
  let Constructor: MathLiveModule["MathfieldElement"] | null = null;
  let field: MathfieldElement | null = null;
  let pending: VisualTexPreviewState | null = null;
  let pendingKey = "";
  let valueKey = "";
  let renderedDraft: VisualTexPreviewDraft | null = null;
  let positionIndex: VisualTexPreviewPositionIndex | null = null;
  let renderFrame = 0;
  let syncTimer = 0;
  let awaitingCommitVerification = false;
  let commitAttempts = 0;
  let removePointerListener = (): void => {};
  const placeholderLayer = document.createElement("div");
  placeholderLayer.className = "noema-visualtex-preview-placeholders";
  const caret = document.createElement("div");
  caret.className = "noema-visualtex-preview-caret";
  caret.hidden = true;

  const cancelScheduledSync = (): void => {
    window.clearTimeout(syncTimer);
    syncTimer = 0;
  };

  const replaceField = (latex: string, display: boolean): MathfieldElement => {
    if (!Constructor) throw new Error("MathLive MathfieldElement is unavailable in this runtime");
    const next = createNoemaMathfield(Constructor);
    next.className = "noema-visualtex-preview-field";
    next.classList.toggle("is-display", display);
    next.readOnly = true;
    next.tabIndex = -1;
    next.setAttribute("aria-label", "LiveTeX 跟随预览");
    next.setAttribute("aria-readonly", "true");
    next.onScrollIntoView = () => {};
    next.addEventListener("mount", () => installVisualTexPreviewShadowStyles(next), { once: true });
    // Initialize the detached field exactly once. Appending an empty field and
    // immediately calling setValue() again can race MathLive's WebKit render
    // queue and leave its temporary LaTeX source layer visible.
    initializeNoemaMathfield(next, latex, options.macros, { readOnlyMirror: true });
    field = next;
    positionIndex = null;
    host.replaceChildren(next, placeholderLayer, caret);
    next.blur();
    installVisualTexPreviewShadowStyles(next);
    return next;
  };

  // Both the click mapping and the overlay read the same alignment between the
  // rendered atom tree and the CM6 source. It is rebuilt only when the value
  // MathLive actually holds changes, never per caret move.
  const ensurePositionIndex = (active: MathfieldElement): VisualTexPreviewPositionIndex | null => {
    const latex = renderedDraft?.latex ?? (valueKey || null);
    if (latex === null) return null;
    if (!positionIndex
      || positionIndex.source !== latex
      || positionIndex.lastOffset !== active.lastOffset) {
      positionIndex = buildVisualTexPreviewPositionIndex(active, latex);
    }
    return positionIndex;
  };

  const handledPointerEvents = new WeakSet<Event>();
  const onPointerDown = (event: PointerEvent): void => {
    const active = field;
    if (event.button > 0 || handledPointerEvents.has(event)
      || suspended || !active || !pending || !options.onSourcePosition) return;
    handledPointerEvents.add(event);
    event.preventDefault();
    event.stopPropagation();
    const index = ensurePositionIndex(active);
    if (!index) return;
    const position = Math.max(0, Math.min(active.lastOffset, active.getOffsetFromPoint(
      event.clientX,
      event.clientY,
      { bias: 0 },
    )));
    options.onSourcePosition(visualTexPreviewSourceOffsetFromIndex(index, position));
  };

  const updateOverlay = (active: MathfieldElement): void => {
    caret.hidden = true;
    if (!renderedDraft) return;
    const mapping = ensurePositionIndex(active);
    if (!mapping) return;
    if (mapping.degraded) {
      // No exact geometry for a formula this large; drawing an approximate
      // caret over it would be worse than drawing none.
      placeholderLayer.replaceChildren();
      return;
    }
    // One layout read for the whole overlay pass.
    const hostRect = host.getBoundingClientRect();
    const markers = renderedDraft.placeholders;
    while (placeholderLayer.childElementCount < markers.length) {
      const marker = document.createElement("div");
      marker.className = "noema-visualtex-preview-placeholder";
      placeholderLayer.append(marker);
    }
    while (placeholderLayer.childElementCount > markers.length) {
      placeholderLayer.lastElementChild?.remove();
    }
    markers.forEach((marker, index) => {
      const element = placeholderLayer.children[index] as HTMLElement;
      const geometry = visualTexPreviewOverlayGeometry(active, hostRect, marker.offset, mapping);
      element.hidden = !geometry;
      element.classList.toggle("is-active", Boolean(marker.active));
      element.classList.toggle("is-mirror", Boolean(marker.mirror));
      if (!geometry) return;
      element.style.left = `${Math.round(geometry.left)}px`;
      element.style.top = `${Math.round(geometry.top)}px`;
      element.style.height = `${Math.max(12, Math.round(geometry.height))}px`;
    });
    if (renderedDraft.caretOffset === null) return;
    const geometry = visualTexPreviewOverlayGeometry(
      active,
      hostRect,
      renderedDraft.caretOffset,
      mapping,
    );
    if (!geometry) return;
    caret.style.left = `${Math.round(geometry.left)}px`;
    caret.style.top = `${Math.round(geometry.top)}px`;
    caret.style.height = `${Math.max(12, Math.round(geometry.height))}px`;
    caret.hidden = false;
  };

  /**
   * Whether MathLive actually holds the value it was last given.
   *
   * It does not always. `setValue(…, { insertionMode: "replaceAll" })` can leave
   * an atom from the previous content behind — an accent whose argument was
   * still being typed is the reproducible case: after `sssss\bar` → `sssss`,
   * `getValue()` comes back as `sssss\bar`, so the stray overline stays on
   * screen forever. Clearing the field first, collapsing the selection, or
   * selecting all before the assignment all fail to dislodge it; only a fresh
   * element does. `mathfield.dirty` is checked alongside because
   * `requestUpdate()` refuses to schedule any repaint while it is set and only
   * clears it at the very end of `render()`, so an interrupted render freezes
   * the DOM the same way.
   */
  const commitLooksApplied = (active: MathfieldElement): boolean => {
    if (Boolean((active as unknown as { _mathfield?: { dirty?: boolean } })._mathfield?.dirty)) {
      return false;
    }
    // Compare ignoring whitespace and MathLive's synthesized placeholders: an
    // over-strict check would rebuild the field on ordinary input, which is
    // worse than the fault it guards against.
    const collapse = (value: string): string => (
      stripVisualTexPlaceholders(normalizeVisualTexLatex(value)).replace(/\s+/g, "")
    );
    return collapse(active.getValue("latex")) === collapse(valueKey);
  };

  /**
   * Rebuild the mirror around the value that failed to apply. Nothing short of
   * a new element recovers the cases above, so there is no point retrying the
   * assignment first; the second attempt only exists to stop a loop if even a
   * fresh field disagrees.
   */
  const recoverPreviewField = (): boolean => {
    // Giving up must still leave a usable frame: the caller falls through to
    // the overlay and onRendered() so the pop is at least placed and sized.
    if (commitAttempts >= 2) return false;
    visualTexPreviewRecoveries++;
    commitAttempts++;
    positionIndex = null;
    replaceField(valueKey, pending?.display ?? false);
    awaitingCommitVerification = true;
    notifyRendered();
    return true;
  };

  const notifyRendered = (): void => {
    window.cancelAnimationFrame(renderFrame);
    renderFrame = window.requestAnimationFrame(() => {
      renderFrame = 0;
      if (destroyed || suspended || !field || !pending) return;
      const contentChanged = awaitingCommitVerification;
      if (awaitingCommitVerification) {
        awaitingCommitVerification = false;
        if (!commitLooksApplied(field) && recoverPreviewField()) return;
      }
      try {
        updateOverlay(field);
        options.onRendered?.(contentChanged);
      } catch {
        // Incomplete source is normal while typing/deleting. Keep the last
        // MathLive frame alive even if that transient atom tree has no stable
        // geometry for an overlay yet.
        caret.hidden = true;
        placeholderLayer.replaceChildren();
        options.onRendered?.(contentChanged);
      }
    });
  };

  const render = (state: VisualTexPreviewState): void => {
    const active = field;
    if (!active || destroyed || suspended) return;
    cancelScheduledSync();
    const draft = buildVisualTexPreviewDraft(state.latex, state.placeholders, state.selection);
    renderedDraft = draft;
    try {
      active.classList.toggle("is-display", state.display);
      if (draft.latex !== valueKey) {
        setVisualTexPreviewValue(active, draft.latex);
        positionIndex = null;
        valueKey = draft.latex;
        awaitingCommitVerification = true;
        commitAttempts = 0;
      }
      installVisualTexPreviewShadowStyles(active);
      notifyRendered();
    } catch (error) {
      options.onUnavailable?.(error);
    }
  };

  const scheduleRender = (): void => {
    if (!field || !pending || destroyed || suspended) return;
    cancelScheduledSync();
    window.cancelAnimationFrame(renderFrame);
    renderFrame = 0;
    // The overlay belongs to the rendered atom tree, not the newer CM6 text.
    // Hide it during the short synchronization window instead of showing a
    // caret or snippet stop at a stale position.
    caret.hidden = true;
    placeholderLayer.replaceChildren();
    const delay = Math.max(0, options.syncIdleMs ?? VISUAL_TEX_PREVIEW_SYNC_MS);
    if (delay === 0) {
      render(pending);
      return;
    }
    // A short trailing merge, nothing more. An additional requestIdleCallback
    // hop used to sit here; on a busy page it deferred the commit long after
    // typing stopped and raced suspend(), which read as "the preview lags".
    syncTimer = window.setTimeout(() => {
      syncTimer = 0;
      if (!destroyed && !suspended && pending) render(pending);
    }, delay);
  };

  const ready = (options.loadMathLive?.() ?? loadMathLive())
    .then((module) => {
      if (destroyed) return;
      Constructor = module.MathfieldElement;
      if (!Constructor) throw new Error("MathLive MathfieldElement is unavailable in this runtime");
      Constructor.locale = "zh-cn";
      host.addEventListener("pointerdown", onPointerDown, true);
      // happy-dom and a few older WebKit event paths omit target-phase capture;
      // the bubble registration is a no-op in current WebKit because capture
      // stops propagation first, but keeps the adapter robust in those hosts.
      host.addEventListener("pointerdown", onPointerDown, false);
      removePointerListener = () => {
        host.removeEventListener("pointerdown", onPointerDown, true);
        host.removeEventListener("pointerdown", onPointerDown, false);
      };
      if (pending && !suspended) {
        renderedDraft = buildVisualTexPreviewDraft(
          pending.latex,
          pending.placeholders,
          pending.selection,
        );
        replaceField(renderedDraft.latex, pending.display);
        valueKey = renderedDraft.latex;
        notifyRendered();
      } else if (!suspended) {
        replaceField("", false);
      }
    })
    .catch((error) => {
      if (!destroyed && !suspended) options.onUnavailable?.(error);
    });

  return {
    ready,
    update(state) {
      if (destroyed) return;
      const wasSuspended = suspended;
      suspended = false;
      const nextPendingKey = `${state.display ? "display" : "inline"}\n${state.latex}\n${state.selection.head}\n${state.placeholders.map((placeholder) => (
        `${placeholder.offset}:${placeholder.active ? 1 : 0}:${placeholder.mirror ? 1 : 0}`
      )).join(",")}`;
      if (nextPendingKey === pendingKey) {
        if (field && !syncTimer) notifyRendered();
        return;
      }
      pendingKey = nextPendingKey;
      pending = {
        ...state,
        selection: { ...state.selection },
        placeholders: state.placeholders.map((placeholder) => ({ ...placeholder })),
      };
      if (!field && Constructor) {
        renderedDraft = buildVisualTexPreviewDraft(
          pending.latex,
          pending.placeholders,
          pending.selection,
        );
        replaceField(renderedDraft.latex, pending.display);
        valueKey = renderedDraft.latex;
        notifyRendered();
        return;
      }
      if (field) {
        const nextLatex = normalizeVisualTexLatex(pending.latex);
        if (wasSuspended || !valueKey || nextLatex === valueKey) {
          cancelScheduledSync();
          render(pending);
        } else {
          scheduleRender();
        }
      }
    },
    suspend() {
      if (destroyed || suspended) return;
      suspended = true;
      window.cancelAnimationFrame(renderFrame);
      cancelScheduledSync();
      renderFrame = 0;
      pending = null;
      pendingKey = "";
      renderedDraft = null;
      positionIndex = null;
      caret.hidden = true;
      placeholderLayer.replaceChildren();
      field?.blur();
    },
    destroy() {
      destroyed = true;
      suspended = true;
      window.cancelAnimationFrame(renderFrame);
      cancelScheduledSync();
      removePointerListener();
      removePointerListener = () => {};
      field?.blur();
      field = null;
      pending = null;
      renderedDraft = null;
      positionIndex = null;
      pendingKey = "";
      valueKey = "";
      host.replaceChildren();
    },
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
  let inlineResizeObserver: ResizeObserver | null = null;
  let inlineResizeFrame = 0;

  const scheduleInlineResize = (active: MathfieldElement): void => {
    if (inlineResizeFrame || destroyed) return;
    inlineResizeFrame = window.requestAnimationFrame(() => {
      inlineResizeFrame = 0;
      if (destroyed || field !== active || !active.isConnected) return;
      const content = active.shadowRoot?.querySelector<HTMLElement>("[part='content']") ?? null;
      const latex = content?.querySelector<HTMLElement>(".ML__latex") ?? null;
      if (content && latex) {
        let visualTop = latex.getBoundingClientRect().top;
        let visualBottom = latex.getBoundingClientRect().bottom;
        for (const element of latex.querySelectorAll<HTMLElement>(
          "[data-atom-id], svg",
        )) {
          const candidate = element.getBoundingClientRect();
          if (!Number.isFinite(candidate.top) || !Number.isFinite(candidate.bottom)
            || candidate.height <= 0) continue;
          visualTop = Math.min(visualTop, candidate.top);
          visualBottom = Math.max(visualBottom, candidate.bottom);
        }
        const fieldRect = active.getBoundingClientRect();
        const style = getComputedStyle(host);
        const current = {
          top: Number.parseFloat(style.getPropertyValue("--noema-inline-math-shell-top")) || 0,
          bottom: Number.parseFloat(style.getPropertyValue("--noema-inline-math-shell-bottom")) || 0,
        };
        const insets = visualTexMathBottomLeftInsets(
          { top: fieldRect.top, bottom: fieldRect.bottom },
          { top: visualTop, bottom: visualBottom },
        );
        if (Math.abs(insets.top - current.top) >= 0.5
          || Math.abs(insets.bottom - current.bottom) >= 0.5) {
          host.style.setProperty("--noema-inline-math-shell-top", `${insets.top}px`);
          host.style.setProperty("--noema-inline-math-shell-bottom", `${insets.bottom}px`);
        }
      }
      const rect = active.getBoundingClientRect();
      // MathLive already encodes TeX ascent/depth with struts. Its own border
      // box is the only reliable geometry; interpreting nested vlist offsets
      // as host padding double-counts them and creates enormous blank space.
      host.dispatchEvent(new CustomEvent("aaronnote:inline-math-resize", {
        detail: { width: rect.width, height: rect.height },
      }));
    });
  };

  const syncDraft = (): void => {
    if (!field) return;
    draft = syncVisualTexMathfieldDraft(field, options.onInput);
  };

  const moveTabstop = (active: MathfieldElement, backward: boolean): VisualTexTabstopMove => {
    suppressMoveOutCommit = true;
    try {
      return moveVisualTexTabstop(active, backward);
    } finally {
      suppressMoveOutCommit = false;
    }
  };

  const moveWithinFormula = (
    active: MathfieldElement,
    backward: boolean,
  ): VisualTexNavigationStep => {
    suppressMoveOutCommit = true;
    try {
      return advanceVisualTexNavigation(active, backward);
    } finally {
      suppressMoveOutCommit = false;
      closeCompletion(host);
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
          if (!completionConsumesKey(host, key)) {
            const backward = Boolean(key.shiftKey);
            const result = moveTabstop(active, backward);
            if (result === "boundary"
              && requestVisualTexSnippetBoundaryHandoff(host, backward)) {
              syncDraft();
              options.onCommit(backward ? "backward" : "forward");
            }
          }
          return true;
        }
        const bracketDirection = visualTexBracketDirection(key);
        if (bracketDirection) {
          const backward = bracketDirection === "backward";
          const result = moveWithinFormula(active, backward);
          if (result === "boundary"
            && requestVisualTexSnippetBoundaryHandoff(host, backward)) {
            syncDraft();
            options.onCommit(backward ? "backward" : "forward");
          }
          return true;
        }
        return false;
      };

      next.addEventListener("input", () => {
        syncDraft();
        requestCompletion(host, next);
        scheduleInlineResize(next);
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
      if (typeof ResizeObserver !== "undefined") {
        inlineResizeObserver = new ResizeObserver(() => scheduleInlineResize(next));
        inlineResizeObserver.observe(next);
      }
      removeHostKeyBridge = addHostKeyBridge(host, () => field, handleInlineKey);
      window.requestAnimationFrame(() => {
        if (destroyed || field !== next || !next.isConnected) return;
        scheduleInlineResize(next);
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
    sourceOffset: () => field ? visualTexMathfieldSourceOffset(field) : 0,
    focus: () => focusVisualTexField(field),
    destroy: () => {
      destroyed = true;
      closeCompletion(host);
      removeHostKeyBridge();
      inlineResizeObserver?.disconnect();
      inlineResizeObserver = null;
      if (inlineResizeFrame) window.cancelAnimationFrame(inlineResizeFrame);
      inlineResizeFrame = 0;
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
        finishAllVisualTexSnippetSessions(next);
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
            const backward = Boolean(key.shiftKey);
            suppressMoveOutCommit = true;
            let result: VisualTexTabstopMove;
            try {
              result = moveVisualTexTabstop(active, backward);
            } finally {
              suppressMoveOutCommit = false;
            }
            if (result === "boundary"
              && requestVisualTexSnippetBoundaryHandoff(host, backward)) {
              emitDraft();
              options.onCommit(backward ? "backward" : "forward");
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
          if (result === "boundary"
            && requestVisualTexSnippetBoundaryHandoff(host, backward)) {
            emitDraft();
            options.onCommit(backward ? "backward" : "forward");
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
    sourceOffset: () => field ? visualTexMathfieldSourceOffset(field) : 0,
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
          if (result === "boundary") {
            const index = activeRowIndex();
            if (backward && index > 0) {
              focusRow(index - 1, true);
            } else if (!backward && index < rows.length - 1) {
              focusRow(index + 1);
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
    sourceOffset: () => {
      const active = activeField ?? rows[0]?.field;
      if (!active) return 0;
      const rowIndex = Math.max(0, rows.findIndex(({ field }) => field === active));
      const values = rows.map(({ field }) => visualTexMathfieldLatex(field));
      const prefix = values.slice(0, rowIndex);
      prefix.push(visualTexMathfieldRangeLatex(active, 0, active.position));
      return serializeVisualTexDisplayRows(currentLayout, prefix).length;
    },
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
