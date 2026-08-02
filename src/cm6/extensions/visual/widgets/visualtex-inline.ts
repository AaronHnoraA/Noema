/*
 * Inline MathLive adapter extracted and adapted from VisualTeX's
 * apps/macos/src/editor/MathEditor.tsx.
 *
 * Upstream: https://github.com/paulhe666/visualtex
 * Revision: 5e3ed2a56ba53643a463c6ea4c2cf1a5675e691c
 * Copyright (c) paulhe666
 * SPDX-License-Identifier: MIT
 */

import type { MathfieldElement } from "mathlive";
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
  | "space-forward"
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
  apply: (template: string, deleteBefore: number) => boolean;
  applyLayout?: (layout: VisualTexDisplayLayout, deleteBefore: number) => boolean;
};

export type VisualTexMathHostKey = {
  key: string;
  text?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
};

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
  field.selection = { ranges: [[range[0], range[1]]], direction: "forward" };
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
}

function configureNoemaMathfield(field: MathfieldElement): void {
  field.smartMode = false;
  field.smartFence = false;
  field.smartSuperscript = false;
  field.removeExtraneousParentheses = false;
  // MathLive's default Space command navigates out of the current parent and
  // serializes no whitespace. Noema gives Space an explicit TeX meaning.
  field.mathModeSpace = "\\,";
  field.maxMatrixCols = 10;
  field.mathVirtualKeyboardPolicy = "manual";
}

function createNoemaMathfield(Constructor: MathLiveModule["MathfieldElement"]): MathfieldElement {
  // Disable MathLive's completion stack at construction time. No mount-time
  // listener or secondary shortcut dictionary is kept alive: Noema owns the
  // only snippet index, popup, ranking and key handling used by LiveTeX.
  // Scientific-notation rewriting is another MathLive text shortcut. Noema
  // keeps typed TeX stable and offers structural changes through its own
  // snippet/company completion pipeline instead.
  Constructor.scientificNotationTemplate = null;
  const field = new Constructor({
    inlineShortcuts: {},
    popoverPolicy: "off",
    environmentPopoverPolicy: "off",
  });
  configureNoemaMathfield(field);
  return field;
}

/** Read only standard TeX from MathLive; editor prompts never enter the note. */
export function visualTexMathfieldLatex(field: Pick<MathfieldElement, "getValue">): string {
  return normalizeVisualTexLatex(field.getValue("latex-without-placeholders"));
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
  return normalizeVisualTexLatex(field.getValue(from, to, "latex-without-placeholders"));
}

/**
 * KaTeX macro maps use command keys such as `\\R`; MathLive's MacroDictionary
 * uses the command name without the leading backslash. Keep one canonical
 * macro source and adapt only at the MathLive boundary.
 */
export function visualTexMathLiveMacros(
  macros: Record<string, string>,
): Record<string, { def: string; captureSelection: false }> {
  const result: Record<string, { def: string; captureSelection: false }> = {};
  for (const [command, expansion] of Object.entries(macros)) {
    const name = command.replace(/^\\+/, "");
    // MathLive defaults custom macros to captureSelection=true, which makes the
    // rendered expansion atomic. Keep the macro's standard TeX serialization,
    // but let arrows and pointer hit-testing enter its argument/body atoms.
    if (name) result[name] = { def: expansion, captureSelection: false };
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
  field.macros = visualTexMathLiveMacros(macros);
  field.setValue(normalizeVisualTexLatex(latex), { selectionMode: "after" });
  field.resetUndo();
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

function applyCompletionTemplate(
  field: MathfieldElement,
  prefix: string,
  template: string,
  deleteBefore: number,
): boolean {
  const suffix = prefix.slice(Math.max(0, prefix.length - deleteBefore));
  const range = suffixRange(field, suffix);
  if (!range) return false;
  field.selection = { ranges: [range] };
  return field.insert(template, {
    format: "latex",
    insertionMode: "replaceSelection",
    selectionMode: "placeholder",
    focus: true,
    feedback: false,
    scrollIntoView: false,
  });
}

function removeCompletionPrefix(field: MathfieldElement, prefix: string, deleteBefore: number): boolean {
  const suffix = prefix.slice(Math.max(0, prefix.length - deleteBefore));
  const range = suffixRange(field, suffix);
  if (!range) return false;
  field.selection = { ranges: [range] };
  return field.insert("", {
    format: "latex",
    insertionMode: "replaceSelection",
    selectionMode: "after",
    focus: true,
    feedback: false,
    scrollIntoView: false,
  });
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
      apply: (template, deleteBefore) => applyCompletionTemplate(field, prefix, template, deleteBefore),
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
  return field.executeCommand(["typedText", text, {
    focus: true,
    feedback: false,
    simulateKeystroke: true,
  }]);
}

function insertMathSpace(field: MathfieldElement): boolean {
  return field.insert("\\,", {
    format: "latex",
    selectionMode: "after",
    focus: true,
    feedback: false,
    scrollIntoView: false,
  });
}

function collapsedAtMathfieldEnd(field: MathfieldElement): boolean {
  const range = field.selection.ranges[0];
  return Boolean(range && range[0] === range[1] && field.position >= field.lastOffset);
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
      field.executeCommand("selectAll");
      return "handled";
    }
    if (lower === "z") {
      field.executeCommand(key.shiftKey ? "redo" : "undo");
      refreshCompletion(host, field);
      return "handled";
    }
  }
  if (primary || key.altKey) return "continue";
  if (normalized === "Escape") return "commit";
  if (normalized === "Backspace" || normalized === "Delete") {
    field.executeCommand(normalized === "Backspace" ? "deleteBackward" : "deleteForward");
    refreshCompletion(host, field);
    return "handled";
  }
  if (normalized === " ") {
    insertMathSpace(field);
    refreshCompletion(host, field);
    return "handled";
  }
  const command = normalized === "ArrowLeft" ? "moveToPreviousChar"
    : normalized === "ArrowRight" ? "moveToNextChar"
      : normalized === "ArrowUp" ? "moveUp"
        : normalized === "ArrowDown" ? "moveDown"
          : normalized === "Home" ? "moveToMathfieldStart"
            : normalized === "End" ? "moveToMathfieldEnd"
              : "";
  if (command) {
    field.executeCommand(command);
    closeCompletion(host);
    return "handled";
  }
  const text = typeof key.text === "string" ? key.text : normalized.length === 1 ? normalized : "";
  if (text) {
    typedText(field, text);
    refreshCompletion(host, field);
    return "handled";
  }
  return "continue";
}

type VisualTexTabstopMove = "placeholder" | "edge" | "boundary";

function moveVisualTexTabstop(field: MathfieldElement, backward: boolean): VisualTexTabstopMove {
  const before = `${field.position}:${field.selection.ranges
    .map(([from, to]) => `${from}-${to}`)
    .join(",")}`;
  field.executeCommand(backward ? "moveToPreviousPlaceholder" : "moveToNextPlaceholder");
  const after = `${field.position}:${field.selection.ranges
    .map(([from, to]) => `${from}-${to}`)
    .join(",")}`;
  if (after !== before) return "placeholder";
  const edge = backward ? 0 : field.lastOffset;
  if (field.position !== edge) {
    field.executeCommand(backward ? "moveToMathfieldStart" : "moveToMathfieldEnd");
    return "edge";
  }
  return "boundary";
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
  // MathLive currently reports `addRowAfter` as handled even at the ordinary
  // root, where there is no array row to add. Only accept the command when it
  // actually changed the TeX; otherwise promote the formula to `aligned`.
  const before = visualTexMathfieldLatex(field);
  field.executeCommand("addRowAfter");
  const after = visualTexMathfieldLatex(field);
  if (after !== before) return after;
  const selection = field.selection.ranges[0] ?? [field.position, field.position];
  const from = Math.min(selection[0], selection[1]);
  const to = Math.max(selection[0], selection[1]);
  const left = visualTexMathfieldRangeLatex(field, 0, from);
  const right = visualTexMathfieldRangeLatex(field, to, field.lastOffset);
  const next = `\\begin{aligned}${left}\\\\${right || "{}"}\\end{aligned}`;
  field.setValue(next, { selectionMode: "after", focus: true });
  field.executeCommand("moveToMathfieldEnd");
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
      field.focus();
      closeCompletion(host);
    });
    bar.append(control);
  };
  button("B", "粗体", () => field.applyStyle({ variantStyle: "bold" }, { operation: "toggle" }));
  button("I", "斜体", () => field.applyStyle({ variantStyle: "italic" }, { operation: "toggle" }));
  button("↹", "下一个占位符", () => { moveVisualTexTabstop(field, false); }, false);
  button("全选", "选择整个公式", () => { field.executeCommand("selectAll"); }, false);

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
  let boundarySpaceArmed = false;
  let commandBoundaryArmed: "forward" | "backward" | null = null;
  let suppressMoveOutCommit = false;

  const syncDraft = (): void => {
    if (!field) return;
    draft = syncVisualTexMathfieldDraft(field, options.onInput);
  };

  const moveWithinOrOut = (
    active: MathfieldElement,
    backward: boolean,
    allowExit: boolean,
  ): void => {
    const direction = backward ? "backward" : "forward";
    const wasArmed = commandBoundaryArmed === direction;
    suppressMoveOutCommit = true;
    let result: VisualTexTabstopMove;
    try {
      result = moveVisualTexTabstop(active, backward);
    } finally {
      suppressMoveOutCommit = false;
    }
    if (allowExit && result === "boundary" && wasArmed) {
      commandBoundaryArmed = null;
      syncDraft();
      options.onCommit(direction);
      return;
    }
    commandBoundaryArmed = allowExit && (result === "edge" || result === "boundary")
      ? direction
      : null;
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

      next.addEventListener("input", () => {
        syncDraft();
        requestCompletion(host, next);
      });
      next.addEventListener("keydown", (event) => {
        if (event.isComposing) return;
        const key = {
          key: event.key,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          altKey: event.altKey,
          shiftKey: event.shiftKey,
        };
        if (event.key !== " ") boundarySpaceArmed = false;
        if (!((event.metaKey || event.ctrlKey) && !event.altKey && (event.key === "[" || event.key === "]"))) {
          commandBoundaryArmed = null;
        }
        if (commitFromKey(key)) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (event.key === " ") {
          if (completionConsumesKey(host, key)) {
            event.preventDefault();
            event.stopPropagation();
            boundarySpaceArmed = false;
            return;
          }
          if (collapsedAtMathfieldEnd(next)) {
            event.preventDefault();
            event.stopPropagation();
            if (boundarySpaceArmed) {
              next.executeCommand("deleteBackward");
              draft = visualTexMathfieldLatex(next);
              options.onInput(draft);
              boundarySpaceArmed = false;
              options.onCommit("space-forward");
            } else {
              insertMathSpace(next);
              draft = visualTexMathfieldLatex(next);
              options.onInput(draft);
              boundarySpaceArmed = true;
              refreshCompletion(host, next);
            }
            return;
          }
        }
        const common = runCommonMathfieldKey(host, next, key, event.key !== " ");
        if (common === "commit") {
          event.preventDefault();
          event.stopPropagation();
          syncDraft();
          options.onCommit("forward");
          return;
        }
        if (common === "handled") {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          if (visualTexSupportsRows(visualTexMathfieldLatex(next))) {
            draft = insertVisualTexInlineRow(next);
            options.onInput(draft);
            requestCompletion(host, next);
          }
          return;
        }
        if (event.key === "Tab") {
          event.preventDefault();
          event.stopPropagation();
          requestCompletion(host, next);
          if (!completionConsumesKey(host, key)) moveWithinOrOut(next, event.shiftKey, false);
          return;
        }
        if ((event.metaKey || event.ctrlKey) && !event.altKey && (event.key === "[" || event.key === "]")) {
          event.preventDefault();
          event.stopPropagation();
          moveWithinOrOut(next, event.key === "[", true);
        }
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
      removeHostKeyBridge = addHostKeyBridge(host, () => field, (active, key) => {
        if (key.key !== " ") boundarySpaceArmed = false;
        if (!((key.metaKey || key.ctrlKey) && !key.altKey && (key.key === "[" || key.key === "]"))) {
          commandBoundaryArmed = null;
        }
        if (commitFromKey(key)) return true;
        if (key.key === " ") {
          if (completionConsumesKey(host, key)) {
            boundarySpaceArmed = false;
            return true;
          }
          if (collapsedAtMathfieldEnd(active)) {
            if (boundarySpaceArmed) {
              active.executeCommand("deleteBackward");
              draft = visualTexMathfieldLatex(active);
              options.onInput(draft);
              boundarySpaceArmed = false;
              options.onCommit("space-forward");
            } else {
              insertMathSpace(active);
              draft = visualTexMathfieldLatex(active);
              options.onInput(draft);
              boundarySpaceArmed = true;
              refreshCompletion(host, active);
            }
            return true;
          }
        }
        const common = runCommonMathfieldKey(host, active, key, key.key !== " ");
        if (common === "commit") {
          syncDraft();
          options.onCommit("forward");
          return true;
        }
        if (common === "handled") return true;
        if (key.key === "Enter") {
          if (visualTexSupportsRows(visualTexMathfieldLatex(active))) {
            draft = insertVisualTexInlineRow(active);
            options.onInput(draft);
            requestCompletion(host, active);
          }
          return true;
        }
        if (key.key === "Tab") {
          requestCompletion(host, active);
          if (!completionConsumesKey(host, key)) moveWithinOrOut(active, Boolean(key.shiftKey), false);
          return true;
        }
        if ((key.metaKey || key.ctrlKey) && !key.altKey && (key.key === "[" || key.key === "]")) {
          moveWithinOrOut(active, key.key === "[", true);
          return true;
        }
        return false;
      });
      window.requestAnimationFrame(() => {
        if (destroyed || field !== next || !next.isConnected) return;
        next.focus();
        placeInitialSelection(next, options.entry);
        closeCompletion(host);
      });
    })
    .catch((error) => {
      if (!destroyed) options.onUnavailable(error);
    });

  return {
    ready,
    value: () => field ? visualTexMathfieldLatex(field) : draft,
    focus: () => field?.focus(),
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
  let commandBoundaryArmed: "forward" | "backward" | null = null;
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
        next.setValue(converted, { selectionMode: "after", focus: true });
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
          next.focus();
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
            next.focus();
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
              next.focus();
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
        addRow.disabled = !enabled;
        removeRow.disabled = !enabled;
      }
      updateRowControls();

      layout.addEventListener("change", () => {
        applyDisplayLayoutSnippet(layout.value as VisualTexDisplayLayout);
      });

      const handleDisplayKey = (active: MathfieldElement, key: VisualTexMathHostKey): boolean => {
        const boundaryCommand = (key.metaKey || key.ctrlKey)
          && !key.altKey
          && (key.key === "[" || key.key === "]");
        if (!boundaryCommand) commandBoundaryArmed = null;
        if (commitFromKey(key)) return true;
        if (completionConsumesKey(host, key)) return true;
        const normalized = key.key === "Esc" ? "Escape" : key.key;
        if (normalized === "Escape") {
          emitDraft();
          options.onCommit("forward");
          return true;
        }
        if (normalized === "Enter") {
          if (visualTexSupportsRows(visualTexMathfieldLatex(active))) {
            draft = insertVisualTexInlineRow(active);
            options.onInput(draft);
            layout.value = visualTexDisplayLayout(draft);
            refreshCompletion(host, active, applyDisplayLayoutSnippet);
          }
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
        if ((key.metaKey || key.ctrlKey) && !key.altKey && (normalized === "[" || normalized === "]")) {
          const backward = normalized === "[";
          const direction = backward ? "backward" : "forward";
          const wasArmed = commandBoundaryArmed === direction;
          suppressMoveOutCommit = true;
          let result: VisualTexTabstopMove;
          try {
            result = moveVisualTexTabstop(active, backward);
          } finally {
            suppressMoveOutCommit = false;
          }
          if (result === "boundary" && wasArmed) {
            commandBoundaryArmed = null;
            emitDraft();
            options.onCommit(direction);
          } else {
            commandBoundaryArmed = result === "edge" || result === "boundary" ? direction : null;
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
        next.focus();
        placeInitialSelection(next, options.entry);
        closeCompletion(host);
      });
    })
    .catch((error) => {
      if (!destroyed) options.onUnavailable(error);
    });

  return {
    ready,
    value: () => field ? visualTexMathfieldLatex(field) : draft,
    focus: () => field?.focus(),
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
  let commandBoundaryArmed: "forward" | "backward" | null = null;
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
        row.field.focus();
        row.field.position = atEnd ? row.field.lastOffset : 0;
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
        if (addRowButton) addRowButton.disabled = !enabled;
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
          first!.field.setValue(merged, { selectionMode: "after", focus: true });
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
        activeField?.focus();
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
          commandBoundaryArmed = null;
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
        if (currentLayout === "equation") return;
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
        const boundaryCommand = (key.metaKey || key.ctrlKey)
          && !key.altKey
          && (key.key === "[" || key.key === "]");
        if (!boundaryCommand) commandBoundaryArmed = null;
        if (commitFromKey(key)) return true;
        if (completionConsumesKey(host, key)) return true;
        const normalized = key.key === "Esc" ? "Escape" : key.key;
        if (normalized === "Escape") {
          emitDraft();
          options.onCommit("forward");
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
        if ((key.metaKey || key.ctrlKey) && !key.altKey && (normalized === "[" || normalized === "]")) {
          const backward = normalized === "[";
          const direction = backward ? "backward" : "forward";
          const wasArmed = commandBoundaryArmed === direction;
          suppressMoveOutCommit = true;
          let result: VisualTexTabstopMove;
          try {
            result = moveVisualTexTabstop(active, backward);
          } finally {
            suppressMoveOutCommit = false;
          }
          if (result === "boundary") {
            const index = activeRowIndex();
            if (backward && index > 0) {
              commandBoundaryArmed = null;
              focusRow(index - 1, true);
            } else if (!backward && index < rows.length - 1) {
              commandBoundaryArmed = null;
              focusRow(index + 1);
            } else if (wasArmed) {
              commandBoundaryArmed = null;
              emitDraft();
              options.onCommit(direction);
            } else commandBoundaryArmed = direction;
          } else commandBoundaryArmed = result === "edge" ? direction : null;
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
          activeField?.focus();
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
            target.focus();
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
              target.focus();
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
        first.focus();
        placeInitialSelection(first, options.entry);
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
    focus: () => (activeField ?? rows[0]?.field)?.focus(),
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
