import { buildVimJumpLabels, VIM_JUMP_LABELS } from "../../src/cm6/vim-jump.ts";

type Rect = { left: number; top: number; bottom: number };
type EditorLike = {
  getMarkdown(): string;
  getMarkdownLength?: () => number;
  markdownBetween?: (from: number, to: number) => string;
  getMarkdownSelection(): { from: number; to: number };
  getSelection?: () => { from: number; to: number };
  insertText(text: string, deleteBefore?: number): { from: number; to: number };
  cursorContext(maxChars?: number): {
    before?: string;
    after?: string;
    rect: Rect | null;
    rectAtOffset?: (offset: number) => Rect | null;
  };
  revealCursor(): void;
};
type VimMode = "insert" | "normal" | "visual" | "visual-line";
type Context = {
  editor: EditorLike;
  host: HTMLElement;
  currentFile: () => string;
  clientId?: () => string;
  vimMode: () => VimMode;
  setStatus: (message: string) => void;
  onChange: (handler: () => void) => () => void;
  onSelectionChange?: (handler: () => void) => () => void;
  onVimModeChange?: (handler: () => void) => () => void;
  onActiveChange?: (handler: () => void) => () => void;
  onFileChange?: (handler: () => void) => () => void;
  onKeyDown: (handler: (event: KeyboardEvent) => boolean) => () => void;
  onAction: (handler: (action: string) => void) => () => void;
  onSettingsChange: (handler: (settings: PluginSettings) => void) => () => void;
  getSettings: () => PluginSettings;
  isActive?: () => boolean;
  isCursorInTexSource?: () => boolean;
  texSourceRangeAtCursor?: () => { from: number; to: number } | null;
  onDocumentEvent: <K extends keyof DocumentEventMap>(
    type: K,
    handler: (event: DocumentEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ) => () => void;
  preserveScroll?: (update: () => void) => void;
  jumpSnippetNext: () => boolean;
  jumpSnippetPrevious: () => boolean;
  forwardDelimiter: () => boolean;
  backwardDelimiter: () => boolean;
};
type CompletionRange = { from: number; to: number };
type CompletionItem = {
  insertText: string;
  range?: {
    start?: { line: number; character: number };
    end?: { line: number; character: number };
  };
  command?: { command?: string; arguments?: unknown[] };
};
type InlineChoice = {
  insertText: string;
  range: CompletionRange;
  item: CompletionItem;
};
type InlineResponse = {
  items?: InlineChoice[];
  status?: { message?: string; kind?: string };
  message?: string;
};
type VisibleCompletion = InlineChoice & {
  acceptedLength: number;
  acceptedBaseLength: number;
  cursor: number;
  documentLength: number;
  beforeFingerprint: string;
  afterFingerprint: string;
};
type CompletionJumpCandidate = {
  length: number;
  label: string;
};
type GraphemePart = {
  from: number;
  to: number;
  text: string;
};
type KeyInput = {
  key: string;
  code?: string;
  text?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
  preventDefault(): void;
};
type CopilotHostKeyDetail = Omit<KeyInput, "preventDefault">;
type PluginSettings = Record<string, string | number | boolean>;
let logRecording = false;
type RuntimeSettings = {
  idleDelayMs: number;
  largeBufferThreshold: number;
};
type NativeCopilotApi = {
  request?: (action: string, body?: unknown) => Promise<unknown>;
};
const defaultIdleDelayMs = 850;
const defaultLargeBufferThresholdKb = 512;
const forwardKeys = new Set(["]", "】", "］", "」", "〕"]);
const backwardKeys = new Set(["[", "【", "［", "「", "〔"]);
const wordKeys = new Set(["\\", "、", "＼"]);
const toCharKeys = new Set(["}", "｝", "〗", "』"]);
const maxJumpCandidates = 4096;
const maxRenderedGraphemes = 2048;
const fingerprintLength = 96;
const duplicateBeforeInputMs = 80;
const jumpInputTimeoutMs = 1500;
const graphemeSegmenter = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : null;

function nativeCopilotApi(): NativeCopilotApi | undefined {
  return (globalThis as typeof globalThis & {
    window?: { aaronnoteApi?: { copilot?: NativeCopilotApi } };
  }).window?.aaronnoteApi?.copilot;
}

function requireNativeCopilotRequest(): (action: string, body?: unknown) => Promise<unknown> {
  const request = nativeCopilotApi()?.request;
  if (!request) throw new Error("Copilot native bridge is unavailable");
  return request;
}

function ensureNativeOk<T>(value: unknown): T {
  const msg = value as { ok?: boolean; message?: unknown };
  if (msg?.ok === false) throw new Error(String(msg.message || "Copilot request failed"));
  return value as T;
}

function numericSetting(value: string | number | boolean | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function normalizeSettings(settings: PluginSettings): RuntimeSettings {
  return {
    idleDelayMs: numericSetting(settings.idleDelayMs, defaultIdleDelayMs),
    largeBufferThreshold: numericSetting(settings.largeBufferThresholdKb, defaultLargeBufferThresholdKb) * 1024,
  };
}

function requestCopilot<T>(action: string, body: unknown = {}): Promise<T> {
  return requireNativeCopilotRequest()(action, body).then((value) => ensureNativeOk<T>(value));
}

function isSupersededCopilotError(error: unknown): boolean {
  if (!error) return false;
  const message = error instanceof Error ? error.message : String(error);
  return /superseded by a new request/i.test(message) || /jsonrpc-error-code\s*\.\s*-32802/i.test(message);
}

function statusSummary(value: unknown, fallback: string): string {
  if (!value || typeof value !== "object") return fallback;
  const obj = value as { status?: { message?: string; kind?: string }; result?: unknown; user?: string; message?: string };
  if (obj.message) return `Copilot: ${obj.message}`;
  if (obj.status?.message) return `Copilot: ${obj.status.message}`;
  if (obj.status?.kind) return `Copilot: ${obj.status.kind}`;
  if (obj.user) return `Copilot: ${obj.user}`;
  if (obj.result != null) return `Copilot: ${JSON.stringify(obj.result).slice(0, 160)}`;
  return fallback;
}

async function copyLog(value: unknown): Promise<void> {
  const text = JSON.stringify(value, null, 2);
  console.log("Noema Copilot log", value);
  await navigator.clipboard?.writeText(text);
}

function targetInHost(host: HTMLElement, target: EventTarget | null): boolean {
  if (!(target instanceof Node)) return false;
  if (target === host || host.contains(target)) return true;
  const root = target.getRootNode?.();
  return root instanceof ShadowRoot && (root.host === host || host.contains(root.host));
}

function primaryOnly(event: KeyInput): boolean {
  const windowsDesktop = window.noemaDesktop?.platform === "win32";
  const primary = windowsDesktop
    ? event.ctrlKey && !event.metaKey
    : (event.metaKey && !event.ctrlKey)
      || (!/Mac/.test(navigator.platform) && event.ctrlKey && !event.metaKey);
  return primary && !event.altKey;
}

function toCharShortcut(event: KeyInput): boolean {
  if (!event.shiftKey) return false;
  return toCharKeys.has(event.key)
    || event.key === "]"
    || event.code === "BracketRight";
}

function printableKey(event: KeyInput, allowComposing = false): string {
  if (event.isComposing && !allowComposing) return "";
  if (event.metaKey || event.ctrlKey || event.altKey) return "";
  const value = event.text && event.text.length === 1 ? event.text : event.key;
  return value.length === 1 ? value : "";
}

function* graphemes(text: string): Generator<GraphemePart> {
  if (!text) return;
  if (graphemeSegmenter) {
    for (const segment of graphemeSegmenter.segment(text)) {
      yield {
        from: segment.index,
        to: segment.index + segment.segment.length,
        text: segment.segment,
      };
    }
    return;
  }
  let from = 0;
  for (const part of text) {
    yield { from, to: from + part.length, text: part };
    from += part.length;
  }
}

function printableTarget(event: KeyInput): string {
  if (event.metaKey || event.ctrlKey || event.altKey) return "";
  const value = event.text || event.key;
  const iterator = graphemes(value);
  if (iterator.next().done) return "";
  return iterator.next().done ? value : "";
}

function graphemeBoundary(text: string, length: number): boolean {
  if (length === 0) return true;
  for (const part of graphemes(text)) {
    if (part.to === length) return true;
    if (part.to > length) return false;
  }
  return false;
}

function nextWordLength(text: string): number {
  if (!text) return 0;
  if (text[0] === "\n") {
    const match = text.match(/^\n[ \t]*/);
    return match?.[0].length ?? 1;
  }
  let length = 0;
  let inWord = false;
  for (const part of graphemes(text)) {
    if (!inWord && /^[ \t]$/u.test(part.text)) {
      length = part.to;
      continue;
    }
    if (!/^[\p{L}\p{N}\p{M}_$-]+$/u.test(part.text)) {
      return inWord ? length : part.to;
    }
    inWord = true;
    length = part.to;
  }
  return length;
}

function visibleText(visible: VisibleCompletion): string {
  return visible.insertText.slice(visible.acceptedLength);
}

function hasBlockingTextAfterCursorOnLine(after: string | undefined): boolean {
  if (!after) return false;
  const lineEnd = after.indexOf("\n");
  const activeLineTail = after.slice(0, lineEnd < 0 ? after.length : lineEnd);
  const trimmed = activeLineTail.trimStart();
  return /^[\p{L}\p{N}_$]/u.test(trimmed);
}

function isIgnorableTexClosingTail(text: string): boolean {
  if (!text) return false;
  let remaining = text;
  let found = false;
  while (remaining) {
    remaining = remaining.replace(/^[ \t]+/, "");
    if (!remaining) return found;
    if (remaining.startsWith("}")) {
      remaining = remaining.slice(1);
      found = true;
      continue;
    }
    if (remaining.startsWith("\\)") || remaining.startsWith("\\]")) {
      remaining = remaining.slice(2);
      found = true;
      continue;
    }
    return false;
  }
  return found;
}

function clampedOffset(markdown: string, offset: number): number {
  return Math.max(0, Math.min(offset, markdown.length));
}

function currentLinePrefix(markdown: string, offset: number): string {
  const cursor = clampedOffset(markdown, offset);
  const lineStart = markdown.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
  return markdown.slice(lineStart, cursor);
}

function completionOffset(editor: EditorLike): number {
  const selection = editor.getMarkdownSelection();
  return selection.to;
}

function activeSelection(editor: EditorLike): { from: number; to: number } {
  return editor.getSelection?.() ?? editor.getMarkdownSelection();
}

function completionRequestDocument(
  markdown: string,
  offset: number,
  maxChars: number,
): { content: string; offset: number; from: number; to: number; clipped: boolean } {
  const cursor = clampedOffset(markdown, offset);
  if (maxChars <= 0 || markdown.length <= maxChars) {
    return { content: markdown, offset: cursor, from: 0, to: markdown.length, clipped: false };
  }

  const beforeBudget = Math.max(0, Math.floor(maxChars * 0.72));
  let from = Math.max(0, cursor - beforeBudget);
  let to = Math.min(markdown.length, from + maxChars);
  from = Math.max(0, to - maxChars);

  return {
    content: markdown.slice(from, to),
    offset: cursor - from,
    from,
    to,
    clipped: from > 0 || to < markdown.length,
  };
}

function completionRequestDocumentFromEditor(
  editor: EditorLike,
  offset: number,
  maxChars: number,
): { content: string; offset: number; from: number; to: number; clipped: boolean } {
  const length = editor.getMarkdownLength?.() ?? editor.getMarkdown().length;
  const safeCursor = Math.max(0, Math.min(offset, length));
  if (maxChars <= 0 || length <= maxChars || !editor.markdownBetween) {
    return completionRequestDocument(editor.getMarkdown(), safeCursor, maxChars);
  }

  const beforeBudget = Math.max(0, Math.floor(maxChars * 0.72));
  let from = Math.max(0, safeCursor - beforeBudget);
  let to = Math.min(length, from + maxChars);
  from = Math.max(0, to - maxChars);

  return {
    content: editor.markdownBetween(from, to),
    offset: safeCursor - from,
    from,
    to,
    clipped: from > 0 || to < length,
  };
}

function completionRequestDocumentForRange(
  editor: EditorLike,
  offset: number,
  range: { from: number; to: number } | null | undefined,
): { content: string; offset: number; from: number; to: number; clipped: boolean } | null {
  if (!range || !editor.markdownBetween) return null;
  const length = editor.getMarkdownLength?.() ?? editor.getMarkdown().length;
  const from = Math.max(0, Math.min(range.from, length));
  const to = Math.max(from, Math.min(range.to, length));
  if (offset < from || offset > to) return null;
  return {
    content: editor.markdownBetween(from, to),
    offset: offset - from,
    from,
    to,
    clipped: from > 0 || to < length,
  };
}

function completionRequestFile(file: string, texContext: boolean): string {
  if (!texContext) return file;
  return file ? `${file}.noema-copilot.tex` : "aaronnote-copilot.noema-copilot.tex";
}

function trimmedCompletionInsertText(
  choice: InlineChoice,
  markdown: string,
  offset: number,
): { insertText: string; acceptedBaseLength: number } {
  const insertText = choice.insertText;
  const cursor = clampedOffset(markdown, offset);
  const rangeFrom = clampedOffset(markdown, choice.range.from);
  const rangeTo = clampedOffset(markdown, choice.range.to);
  if (rangeFrom <= cursor && cursor <= rangeTo) {
    const alreadyPresent = markdown.slice(rangeFrom, cursor);
    if (alreadyPresent && insertText.startsWith(alreadyPresent)) {
      return {
        insertText: insertText.slice(alreadyPresent.length),
        acceptedBaseLength: alreadyPresent.length,
      };
    }
  }

  const linePrefix = currentLinePrefix(markdown, cursor);
  if (linePrefix && insertText.startsWith(linePrefix)) {
    return {
      insertText: insertText.slice(linePrefix.length),
      acceptedBaseLength: linePrefix.length,
    };
  }

  const unindentedLinePrefix = linePrefix.replace(/^[ \t]+/, "");
  if (unindentedLinePrefix && insertText.startsWith(unindentedLinePrefix)) {
    return {
      insertText: insertText.slice(unindentedLinePrefix.length),
      acceptedBaseLength: unindentedLinePrefix.length,
    };
  }

  return { insertText, acceptedBaseLength: 0 };
}

export function setupCopilot(context: Context): () => void {
  const ghost = document.createElement("div");
  ghost.className = "aaronnote-copilot-ghost";
  ghost.hidden = true;
  document.body.appendChild(ghost);
  const jumpHint = document.createElement("div");
  jumpHint.className = "aaronnote-copilot-jump-hint";
  jumpHint.hidden = true;
  document.body.appendChild(jumpHint);

  const style = document.createElement("style");
  style.textContent = `
.aaronnote-copilot-ghost {
  position: fixed;
  z-index: 80;
  pointer-events: none;
  color: color-mix(in srgb, currentColor 38%, transparent);
  max-width: calc(100vw - 24px);
  overflow: hidden;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
  font: inherit;
  line-height: inherit;
}
.aaronnote-copilot-ghost-line {
  min-height: 1em;
  white-space: pre-wrap;
}
.aaronnote-copilot-ghost[data-truncated="true"]::after {
  content: "…";
  position: absolute;
  right: 0;
  bottom: 0;
  padding-left: 0.4em;
  background: linear-gradient(90deg, transparent, var(--aaronnote-bg, Canvas) 38%);
}
.aaronnote-copilot-ghost--lean {
  color: rgb(156 199 255 / 68%);
  text-shadow: 0 1px 2px rgb(0 0 0 / 46%);
}
.aaronnote-copilot-jump-hint {
  position: fixed;
  z-index: 81;
  pointer-events: none;
  padding: 2px 6px;
  border: 1px solid color-mix(in srgb, #f7d774 72%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--aaronnote-bg, Canvas) 88%, transparent);
  color: #f7d774;
  font: 600 11px/1.35 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  box-shadow: 0 2px 8px rgb(0 0 0 / 28%);
  white-space: nowrap;
}
.aaronnote-copilot-jump-target {
  position: relative;
}
.aaronnote-copilot-jump-newline {
  opacity: 0.78;
}
.aaronnote-copilot-jump-target[data-copilot-jump-label]::after {
  content: attr(data-copilot-jump-label);
  position: absolute;
  inset: -0.18em auto auto 0;
  z-index: 1;
  min-width: 1ch;
  padding: 0 0.08em;
  border-radius: 0.18em;
  color: #111827;
  background: #f7d774;
  font-size: 0.72em;
  font-weight: 800;
  line-height: 1.05;
  text-align: center;
  text-shadow: none;
}
`;
  document.head.appendChild(style);

  let timer = 0;
  let jumpTimer = 0;
  let seq = 0;
  let accepting = false;
  let jumpWaitingForTarget = false;
  let jumpCandidates: CompletionJumpCandidate[] | null = null;
  let jumpPrefix = "";
  let recentJumpKeydown: { texts: readonly string[]; at: number } | null = null;
  let visible: VisibleCompletion | null = null;
  let settings = normalizeSettings(context.getSettings());
  let lastScheduleKey = "";
  let focusState: "focused" | "blurred" | "closed" = "blurred";
  let focusedFile = "";
  const cleanups: Array<() => void> = [];

  function clearJump(): void {
    window.clearTimeout(jumpTimer);
    jumpTimer = 0;
    jumpWaitingForTarget = false;
    jumpCandidates = null;
    jumpPrefix = "";
    jumpHint.hidden = true;
  }

  function armJumpTimeout(): void {
    window.clearTimeout(jumpTimer);
    jumpTimer = window.setTimeout(() => {
      jumpTimer = 0;
      if (!jumpWaitingForTarget && !jumpCandidates) return;
      clearJump();
      context.setStatus("Copilot jump timed out");
      renderCompletion();
    }, jumpInputTimeoutMs);
  }

  function noteJumpKeydown(...texts: string[]): void {
    recentJumpKeydown = {
      texts: texts.filter(Boolean),
      at: typeof performance !== "undefined" ? performance.now() : Date.now(),
    };
  }

  function consumePairedBeforeInput(text: string): boolean {
    const recent = recentJumpKeydown;
    if (!recent) return false;
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    recentJumpKeydown = null;
    return now - recent.at <= duplicateBeforeInputMs && recent.texts.includes(text);
  }

  function clearCompletion(invalidate = true): void {
    if (invalidate) seq += 1;
    visible = null;
    clearJump();
    ghost.hidden = true;
    delete ghost.dataset.truncated;
  }

  function copyEditorTypography(): number {
    const active = document.activeElement instanceof HTMLElement
      && context.host.contains(document.activeElement)
      ? document.activeElement
      : context.host;
    const computed = getComputedStyle(active);
    for (const property of ["fontFamily", "fontSize", "fontStyle", "fontWeight", "fontVariant", "letterSpacing"] as const) {
      const value = computed[property];
      if (value) ghost.style[property] = value;
    }
    if (computed.lineHeight) ghost.style.lineHeight = computed.lineHeight;
    const parsed = Number.parseFloat(computed.lineHeight);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  function jumpCandidateMap(): Map<number, string> {
    return new Map((jumpCandidates ?? []).map((candidate) => [candidate.length, candidate.label]));
  }

  function renderGhostText(text: string, visibleLineCount: number): void {
    ghost.replaceChildren();
    const candidateLabels = jumpCandidateMap();
    let lineIndex = 0;
    let line = document.createElement("div");
    line.className = "aaronnote-copilot-ghost-line";
    ghost.appendChild(line);
    let plainText = "";
    const flushPlainText = () => {
      if (!plainText) return;
      line.append(plainText);
      plainText = "";
    };
    let renderedTo = 0;
    let renderedGraphemes = 0;
    for (const part of graphemes(text)) {
      if (lineIndex >= visibleLineCount) break;
      if (renderedGraphemes >= maxRenderedGraphemes) break;
      renderedGraphemes += 1;
      if (part.text === "\n") {
        flushPlainText();
        const label = candidateLabels.get(part.to);
        if (label?.startsWith(jumpPrefix)) {
          const marker = document.createElement("span");
          marker.className = "aaronnote-copilot-jump-target aaronnote-copilot-jump-newline";
          marker.textContent = "↵";
          marker.dataset.copilotJumpLength = String(part.to);
          marker.dataset.copilotJumpLabel = label.slice(jumpPrefix.length) || label;
          line.appendChild(marker);
        }
        renderedTo = part.to;
        lineIndex += 1;
        if (lineIndex >= visibleLineCount) break;
        line = document.createElement("div");
        line.className = "aaronnote-copilot-ghost-line";
        ghost.appendChild(line);
        continue;
      }
      if (!jumpCandidates) {
        plainText += part.text;
        renderedTo = part.to;
        continue;
      }
      const label = candidateLabels.get(part.to);
      if (!label?.startsWith(jumpPrefix)) {
        plainText += part.text;
        renderedTo = part.to;
        continue;
      }
      flushPlainText();
      const span = document.createElement("span");
      span.className = "aaronnote-copilot-jump-target";
      span.textContent = part.text;
      span.dataset.copilotJumpLength = String(part.to);
      span.dataset.copilotJumpLabel = label.slice(jumpPrefix.length) || label;
      line.appendChild(span);
      renderedTo = part.to;
    }
    flushPlainText();
    ghost.dataset.truncated = String(renderedTo < text.length);
  }

  function renderCompletion(): void {
    if (!visible) {
      ghost.hidden = true;
      jumpHint.hidden = true;
      return;
    }
    const text = visibleText(visible);
    if (!text) {
      clearCompletion();
      return;
    }
    const cursor = context.editor.cursorContext(1600);
    const rect = cursor.rect;
    if (!rect) {
      ghost.hidden = true;
      jumpHint.hidden = true;
      return;
    }
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const margin = 12;
    const lineStartOffset = (cursor.before?.lastIndexOf("\n") ?? -1) + 1;
    const lineStartRect = cursor.rectAtOffset?.(lineStartOffset);
    const contentLeft = Math.min(rect.left, lineStartRect?.left ?? rect.left);
    const minWidth = Math.min(160, Math.max(80, viewportWidth - margin * 2));
    const left = viewportWidth > 0
      ? Math.min(Math.max(margin, contentLeft), Math.max(margin, viewportWidth - minWidth - margin))
      : Math.max(0, contentLeft);
    const top = viewportHeight > 0
      ? Math.min(Math.max(0, rect.top), Math.max(0, viewportHeight - 32))
      : Math.max(0, rect.top);
    const computedLineHeight = copyEditorTypography();
    const lineHeight = Math.max(1, computedLineHeight || rect.bottom - rect.top || 24);
    const availableHeight = viewportHeight > 0 ? Math.max(lineHeight, viewportHeight - top - margin) : Number.POSITIVE_INFINITY;
    const visibleLineCount = Number.isFinite(availableHeight)
      ? Math.max(1, Math.floor(availableHeight / lineHeight))
      : maxRenderedGraphemes;
    renderGhostText(text, visibleLineCount);
    const firstLine = ghost.firstElementChild as HTMLElement | null;
    if (firstLine) firstLine.style.paddingLeft = `${Math.max(0, rect.left - left)}px`;
    ghost.style.left = `${left}px`;
    ghost.style.top = `${top}px`;
    ghost.style.maxWidth = viewportWidth > 0 ? `${Math.max(80, viewportWidth - left - margin)}px` : "";
    ghost.style.maxHeight = viewportHeight > 0 ? `${Math.max(32, viewportHeight - top - margin)}px` : "";
    ghost.hidden = false;
    if (jumpWaitingForTarget || jumpCandidates) {
      jumpHint.textContent = jumpWaitingForTarget ? "S · target" : "S · label";
      jumpHint.style.left = `${left}px`;
      jumpHint.style.top = `${Math.max(4, top - 22)}px`;
      jumpHint.hidden = false;
    } else {
      jumpHint.hidden = true;
    }
  }

  function editorStateKey(): string {
    const selection = activeSelection(context.editor);
    const cursor = context.editor.cursorContext(160);
    return [
      context.currentFile(),
      context.vimMode(),
      selection.from,
      selection.to,
      context.editor.getMarkdownLength?.() ?? context.editor.getMarkdown().length,
      cursor.before?.slice(-80) ?? "",
      cursor.after?.slice(0, 80) ?? "",
    ].join("\0");
  }

  function scheduleStateKey(): string {
    const selection = activeSelection(context.editor);
    return [
      context.currentFile(),
      context.vimMode(),
      selection.from,
      selection.to,
      context.editor.getMarkdownLength?.() ?? context.editor.getMarkdown().length,
    ].join("\0");
  }

  function clientBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
    const clientId = context.clientId?.() || "";
    const active = Object.prototype.hasOwnProperty.call(extra, "active")
      ? extra.active
      : document.hasFocus() && (!context.isActive || context.isActive());
    return {
      ...extra,
      ...(clientId ? { clientId } : {}),
      active,
    };
  }

  function notifyFocus(reason = "focus"): Promise<void> {
    const file = context.currentFile();
    if (!file || !document.hasFocus()) return Promise.resolve();
    if (context.isActive && !context.isActive()) return Promise.resolve();
    if (focusState === "focused" && focusedFile === file) return Promise.resolve();
    focusState = "focused";
    focusedFile = file;
    return requestCopilot("focus", clientBody({ file, reason })).then(() => undefined).catch(() => undefined);
  }

  function notifyBlur(reason = "blur"): void {
    if (focusState !== "focused") return;
    const file = focusedFile || context.currentFile();
    focusState = "blurred";
    focusedFile = "";
    window.clearTimeout(timer);
    lastScheduleKey = "";
    clearCompletion();
    void requestCopilot("blur", clientBody({ file, reason, active: false })).catch(() => {});
  }

  function notifyClose(reason = "close"): void {
    if (focusState === "closed") return;
    const file = focusedFile || context.currentFile();
    focusState = "closed";
    focusedFile = "";
    window.clearTimeout(timer);
    lastScheduleKey = "";
    clearCompletion();
    void requestCopilot("close", clientBody({ file, reason, active: false })).catch(() => {});
  }

  function eligible(): boolean {
    if (!eligibleShell()) return false;
    const selection = activeSelection(context.editor);
    if (selection.from !== selection.to) return false;
    return context.isCursorInTexSource?.()
      || !hasBlockingTextAfterCursorOnLine(context.editor.cursorContext(512).after);
  }

  function eligibleShell(): boolean {
    if (context.isActive && !context.isActive()) return false;
    if (!document.hasFocus()) return false;
    if (context.vimMode() !== "insert") return false;
    if (!targetInHost(context.host, document.activeElement)) return false;
    const selection = activeSelection(context.editor);
    return selection.from === selection.to;
  }

  function schedule(): void {
    window.clearTimeout(timer);
    if (!eligible()) {
      clearCompletion();
      return;
    }
    timer = window.setTimeout(() => void requestCompletion(), settings.idleDelayMs);
  }

  function scheduleIfChanged(): void {
    if (!eligibleShell()) {
      window.clearTimeout(timer);
      lastScheduleKey = "";
      if (visible) clearCompletion();
      if (context.isActive && !context.isActive()) notifyBlur("inactive");
      return;
    }
    const key = scheduleStateKey();
    if (key === lastScheduleKey) {
      if (visible) renderCompletion();
      return;
    }
    if (visible) clearCompletion();
    lastScheduleKey = key;
    schedule();
  }

  function completionFingerprints(): {
    cursor: number;
    documentLength: number;
    beforeFingerprint: string;
    afterFingerprint: string;
  } {
    const selection = activeSelection(context.editor);
    const cursor = context.editor.cursorContext(fingerprintLength * 2);
    return {
      cursor: selection.to,
      documentLength: context.editor.getMarkdownLength?.() ?? context.editor.getMarkdown().length,
      beforeFingerprint: cursor.before?.slice(-fingerprintLength) ?? "",
      afterFingerprint: cursor.after?.slice(0, fingerprintLength) ?? "",
    };
  }

  function consumeTypedPrefix(): boolean {
    if (!visible || !context.editor.markdownBetween) return false;
    const selection = activeSelection(context.editor);
    const documentLength = context.editor.getMarkdownLength?.() ?? context.editor.getMarkdown().length;
    const cursorDelta = selection.to - visible.cursor;
    const documentDelta = documentLength - visible.documentLength;
    if (selection.from !== selection.to || cursorDelta <= 0 || cursorDelta !== documentDelta) return false;
    const typed = context.editor.markdownBetween(visible.cursor, selection.to);
    if (!typed || typed.length !== cursorDelta) return false;
    const remaining = visibleText(visible);
    if (!remaining.startsWith(typed) || !graphemeBoundary(remaining, typed.length)) return false;
    const fingerprint = completionFingerprints();
    if (fingerprint.afterFingerprint !== visible.afterFingerprint) return false;

    seq += 1;
    clearJump();
    visible.acceptedLength += typed.length;
    Object.assign(visible, fingerprint);
    if (!visibleText(visible)) clearCompletion(false);
    else renderCompletion();
    return true;
  }

  function handleDocumentChange(): void {
    if (accepting) return;
    const followed = consumeTypedPrefix();
    if (followed) {
      lastScheduleKey = scheduleStateKey();
      schedule();
      return;
    }
    clearCompletion();
    lastScheduleKey = "";
    scheduleIfChanged();
  }

  function handleEditorStateChange(): void {
    if (accepting) return;
    scheduleIfChanged();
  }

  function handleFileChange(): void {
    const previousFile = focusedFile;
    window.clearTimeout(timer);
    lastScheduleKey = "";
    clearCompletion();
    if (focusState === "focused" && previousFile !== context.currentFile()) {
      notifyBlur("file-change");
    }
    scheduleIfChanged();
  }

  async function requestCompletion(): Promise<void> {
    if (!eligible()) return;
    await notifyFocus("inline");
    if (!eligible()) return;
    const fullOffset = completionOffset(context.editor);
    const texContext = Boolean(context.isCursorInTexSource?.());
    const requestDoc = completionRequestDocumentForRange(
      context.editor,
      fullOffset,
      texContext ? context.texSourceRangeAtCursor?.() : null,
    ) ?? completionRequestDocumentFromEditor(context.editor, fullOffset, settings.largeBufferThreshold);
    if (!eligible()) return;
    const key = editorStateKey();
    const currentSeq = ++seq;
    try {
      const response = await requestCopilot<InlineResponse>("inline", {
        ...clientBody(),
        file: completionRequestFile(context.currentFile(), texContext),
        sourceFile: context.currentFile(),
        content: requestDoc.content,
        offset: requestDoc.offset,
        window: requestDoc.clipped ? { from: requestDoc.from, to: requestDoc.to } : undefined,
      });
      if (currentSeq !== seq || key !== editorStateKey() || !eligible()) return;
      const choice = response.items?.[0];
      if (!choice?.insertText) {
        clearCompletion();
        if (response.status?.kind === "Error" && response.status.message) {
          context.setStatus(`Copilot: ${response.status.message}`);
        }
        return;
      }
      if (!context.isCursorInTexSource?.()
        && hasBlockingTextAfterCursorOnLine(context.editor.cursorContext(512).after)) {
        clearCompletion();
        return;
      }
      if (!Number.isFinite(choice.range.from)
        || !Number.isFinite(choice.range.to)
        || choice.range.from < 0
        || choice.range.from > requestDoc.offset
        || choice.range.to < requestDoc.offset
        || choice.range.to > requestDoc.content.length
        || choice.range.from > choice.range.to
        || (choice.range.to > requestDoc.offset
          && (!texContext || !isIgnorableTexClosingTail(
            requestDoc.content.slice(requestDoc.offset, choice.range.to),
          )))) {
        clearCompletion();
        return;
      }
      const trimmed = trimmedCompletionInsertText(choice, requestDoc.content, requestDoc.offset);
      if (texContext && choice.range.to > requestDoc.offset) {
        const closingTail = requestDoc.content.slice(requestDoc.offset, choice.range.to);
        if (trimmed.insertText.endsWith(closingTail)) {
          trimmed.insertText = trimmed.insertText.slice(0, -closingTail.length);
        }
      }
      if (!trimmed.insertText) {
        clearCompletion();
        return;
      }
      visible = {
        ...choice,
        ...trimmed,
        ...completionFingerprints(),
        acceptedLength: 0,
      };
      renderCompletion();
      void requestCopilot("shown", { item: choice.item }).catch(() => {});
    } catch (err) {
      if (currentSeq !== seq || key !== editorStateKey()) return;
      if (isSupersededCopilotError(err)) return;
      clearCompletion();
      context.setStatus(err instanceof Error ? `Copilot: ${err.message}` : "Copilot failed");
    }
  }

  function acceptLength(length: number): boolean {
    if (!visible) return false;
    const remaining = visibleText(visible);
    const requested = Math.max(0, Math.min(length, remaining.length));
    let count = requested >= remaining.length ? remaining.length : 0;
    if (requested < remaining.length) {
      for (const part of graphemes(remaining)) {
        if (part.to > requested) break;
        count = part.to;
      }
    }
    if (count <= 0) return false;
    const text = remaining.slice(0, count);
    const selection = activeSelection(context.editor);
    if (selection.from !== selection.to) {
      clearCompletion();
      return false;
    }
    accepting = true;
    seq += 1;
    window.clearTimeout(timer);
    const insertAndReveal = () => {
      context.editor.insertText(text);
      context.editor.revealCursor();
    };
    if (context.preserveScroll) context.preserveScroll(insertAndReveal);
    else insertAndReveal();
    visible.acceptedLength += text.length;
    Object.assign(visible, completionFingerprints());
    lastScheduleKey = scheduleStateKey();
    if (visible.acceptedLength >= visible.insertText.length) {
      const item = visible.item;
      clearCompletion(false);
      void requestCopilot("accept", { item }).catch(() => {});
    } else {
      renderCompletion();
      void requestCopilot("accept", {
        item: visible.item,
        acceptedLength: visible.acceptedBaseLength + visible.acceptedLength,
      }).catch(() => {});
    }
    // CodeMirror callbacks are synchronous today, but retaining the guard
    // through this task also covers adapters that publish their change and
    // selection notifications in a microtask.
    window.setTimeout(() => {
      accepting = false;
    }, 0);
    return true;
  }

  function acceptAll(): boolean {
    if (!visible) return false;
    return acceptLength(visibleText(visible).length);
  }

  function acceptWord(): boolean {
    if (!visible) return false;
    return acceptLength(nextWordLength(visibleText(visible)));
  }

  function visibleJumpLengths(text: string, target: string): number[] {
    const rect = context.editor.cursorContext(1600).rect;
    if (!rect) return [];
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const margin = 12;
    const computedLineHeight = copyEditorTypography();
    const lineHeight = Math.max(1, computedLineHeight || rect.bottom - rect.top || 24);
    const maxLines = viewportHeight > 0
      ? Math.max(1, Math.floor(Math.max(lineHeight, viewportHeight - rect.top - margin) / lineHeight))
      : Number.POSITIVE_INFINITY;
    const lengths: number[] = [];
    const foldedTarget = target.toLocaleLowerCase();
    let line = 0;
    let scanned = 0;
    for (const part of graphemes(text)) {
      if (line >= maxLines || lengths.length >= maxJumpCandidates) break;
      if (scanned >= maxRenderedGraphemes) break;
      scanned += 1;
      if (part.text.toLocaleLowerCase() === foldedTarget) lengths.push(part.to);
      if (part.text === "\n") line += 1;
    }
    return lengths;
  }

  function beginCompletionJump(): boolean {
    if (!visible) return false;
    jumpWaitingForTarget = true;
    jumpCandidates = null;
    jumpPrefix = "";
    context.setStatus("Copilot jump: type a target character, Esc cancels");
    armJumpTimeout();
    renderCompletion();
    return true;
  }

  function labelCompletionJumpTargets(target: string): boolean {
    if (!visible) return false;
    const lengths = visibleJumpLengths(visibleText(visible), target);
    if (lengths.length === 0) {
      return cancelCompletionJump(`Copilot jump: ${target} not found`);
    }
    const labels = buildVimJumpLabels(lengths.length);
    jumpCandidates = lengths.map((length, index) => ({ length, label: labels[index]! }));
    jumpWaitingForTarget = false;
    jumpPrefix = "";
    armJumpTimeout();
    renderCompletion();
    const elements = [...ghost.querySelectorAll<HTMLElement>(".aaronnote-copilot-jump-target")];
    const measured = elements.some((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 || rect.height > 0 || rect.top !== 0 || rect.bottom !== 0;
    });
    if (measured) {
      const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
      const visibleLengths = elements
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          return rect.bottom > 0
            && (!viewportHeight || rect.top < viewportHeight)
            && rect.right > 0
            && (!viewportWidth || rect.left < viewportWidth);
        })
        .map((element) => Number(element.dataset.copilotJumpLength))
        .filter((length) => Number.isFinite(length) && length > 0);
      if (visibleLengths.length > 0 && visibleLengths.length !== jumpCandidates.length) {
        const visibleLabels = buildVimJumpLabels(visibleLengths.length);
        jumpCandidates = visibleLengths.map((length, index) => ({ length, label: visibleLabels[index]! }));
        renderCompletion();
      }
    }
    context.setStatus(`Copilot jump: ${jumpCandidates.length} ${target} target${jumpCandidates.length === 1 ? "" : "s"}; type a label`);
    return true;
  }

  function cancelCompletionJump(message = "Copilot jump canceled"): boolean {
    clearJump();
    context.setStatus(message);
    renderCompletion();
    return true;
  }

  function handleCompletionJump(event: KeyInput): boolean {
    if (event.key === "Escape") {
      event.preventDefault();
      return cancelCompletionJump();
    }
    if (jumpWaitingForTarget) {
      if (event.key === "Backspace" || event.key === "Delete") {
        event.preventDefault();
        return cancelCompletionJump();
      }
      const target = printableTarget(event);
      if (!target) {
        if (["Alt", "AltGraph", "Control", "Meta", "Shift"].includes(event.key)) return false;
        clearJump();
        context.setStatus("Copilot jump canceled");
        renderCompletion();
        return false;
      }
      event.preventDefault();
      if (event instanceof KeyboardEvent) noteJumpKeydown(target);
      return labelCompletionJumpTargets(target);
    }
    if (!jumpCandidates) return false;
    if (event.key === "Backspace" || event.key === "Delete") {
      event.preventDefault();
      if (!jumpPrefix) {
        jumpWaitingForTarget = true;
        jumpCandidates = null;
        context.setStatus("Copilot jump: type a target character, Esc cancels");
        armJumpTimeout();
        renderCompletion();
        return true;
      }
      jumpPrefix = jumpPrefix.slice(0, -1);
      context.setStatus(jumpPrefix ? `Copilot jump: ${jumpPrefix}` : "Copilot jump: type a label, Esc cancels");
      armJumpTimeout();
      renderCompletion();
      return true;
    }
    const key = printableKey(event, true).toLowerCase();
    if (!key) {
      if (["Alt", "AltGraph", "Control", "Meta", "Shift"].includes(event.key)) return false;
      clearJump();
      context.setStatus("Copilot jump canceled");
      renderCompletion();
      return false;
    }
    event.preventDefault();
    if (event instanceof KeyboardEvent) noteJumpKeydown(key);
    if (!VIM_JUMP_LABELS.includes(key)) return cancelCompletionJump("Copilot jump canceled: invalid label");
    const prefix = `${jumpPrefix}${key}`;
    const matches = jumpCandidates.filter((candidate) => candidate.label.startsWith(prefix));
    if (matches.length === 0) return cancelCompletionJump("Copilot jump canceled: no label");
    const exact = matches.find((candidate) => candidate.label === prefix);
    if (exact) {
      clearJump();
      return acceptLength(exact.length);
    }
    jumpPrefix = prefix;
    context.setStatus(`Copilot jump: ${matches.length} targets`);
    armJumpTimeout();
    renderCompletion();
    return true;
  }

  function handleKeyInput(event: KeyInput): boolean {
    // Native sub-editors (notably LiveTeX) share the document capture phase.
    // When the host marks Copilot inactive, its shortcuts must pass through to
    // that editor instead of invoking source-snippet or delimiter callbacks.
    if (context.isActive && !context.isActive()) return false;
    if (jumpWaitingForTarget || jumpCandidates) return handleCompletionJump(event);
    if (context.vimMode() !== "insert" || !primaryOnly(event)) return false;
    if (!event.shiftKey && forwardKeys.has(event.key)) {
      const handled = visible ? acceptAll() : context.jumpSnippetNext() || context.forwardDelimiter();
      if (handled) event.preventDefault();
      return handled;
    }
    if (!event.shiftKey && backwardKeys.has(event.key)) {
      const handled = context.jumpSnippetPrevious() || context.backwardDelimiter();
      if (handled) event.preventDefault();
      return handled;
    }
    if (!event.shiftKey && wordKeys.has(event.key)) {
      const handled = visible ? acceptWord() : context.jumpSnippetNext() || context.forwardDelimiter();
      if (handled) event.preventDefault();
      return handled;
    }
    if (toCharShortcut(event)) {
      if (visible) {
        const handled = beginCompletionJump();
        if (handled) {
          event.preventDefault();
          if (event instanceof KeyboardEvent) {
            noteJumpKeydown(event.key, event.shiftKey && (event.key === "]" || event.code === "BracketRight") ? "}" : "");
          }
        }
        return handled;
      }
      const handled = context.jumpSnippetNext() || context.forwardDelimiter();
      if (handled) event.preventDefault();
      return handled;
    }
    return false;
  }

  function handleKey(event: KeyboardEvent): boolean {
    if (!targetInHost(context.host, event.target)) return false;
    // Any new physical key supersedes the one-shot paired-beforeinput
    // expectation from the preceding keydown. This keeps the 80ms WebKit
    // dedupe guard from consuming a fast, genuinely new keystroke.
    recentJumpKeydown = null;
    return handleKeyInput(event);
  }

  function consumeJumpBeforeInput(event: InputEvent): boolean {
    if (!jumpWaitingForTarget && !jumpCandidates && !recentJumpKeydown) return false;
    const deleting = event.inputType === "deleteContentBackward" || event.inputType === "deleteContentForward";
    const singleTextInput = event.inputType === "insertText" || event.inputType === "insertCompositionText";
    const text = event.data || "";
    if (!deleting && !singleTextInput) {
      recentJumpKeydown = null;
      if (jumpWaitingForTarget || jumpCandidates) cancelCompletionJump();
      return false;
    }
    if (text && consumePairedBeforeInput(text)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return true;
    }
    if (!jumpWaitingForTarget && !jumpCandidates) return false;
    if (!deleting && !printableTarget({
      key: text,
      text,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      isComposing: event.isComposing,
      preventDefault: () => {},
    })) {
      cancelCompletionJump();
      return false;
    }
    const key = deleting
      ? event.inputType === "deleteContentBackward" ? "Backspace" : "Delete"
      : text;
    const handled = key
      ? handleKeyInput({
          key,
          text: text || undefined,
          metaKey: false,
          ctrlKey: false,
          altKey: false,
          shiftKey: false,
          isComposing: event.isComposing,
          preventDefault: () => event.preventDefault(),
        })
      : false;
    if (!handled && (jumpWaitingForTarget || jumpCandidates)) cancelCompletionJump();
    if (event.defaultPrevented) event.stopImmediatePropagation();
    return event.defaultPrevented;
  }

  function handleHostKeyEvent(event: Event): void {
    const custom = event as CustomEvent<CopilotHostKeyDetail>;
    const detail = custom.detail;
    if (!detail?.key) return;
    recentJumpKeydown = null;
    const handled = handleKeyInput({
      key: detail.key,
      code: detail.code,
      text: detail.text,
      metaKey: Boolean(detail.metaKey),
      ctrlKey: Boolean(detail.ctrlKey),
      altKey: Boolean(detail.altKey),
      shiftKey: Boolean(detail.shiftKey),
      isComposing: Boolean(detail.isComposing),
      preventDefault: () => custom.preventDefault(),
    });
    if (handled) custom.stopImmediatePropagation();
  }

  function runAction(action: string): void {
    void (async () => {
      try {
        if (action === "sign-in") {
          const res = await requestCopilot<unknown>("sign-in");
          const openedUri = res && typeof res === "object" && "openedUri" in res
            ? String((res as { openedUri?: unknown }).openedUri || "")
            : "";
          if (openedUri && window.noemaDesktop?.openExternal) {
            await window.noemaDesktop.openExternal(openedUri);
          }
          const code = res && typeof res === "object" && "userCode" in res ? String((res as { userCode?: unknown }).userCode || "") : "";
          if (code) {
            await navigator.clipboard?.writeText(code);
            context.setStatus(`Copilot login code: ${code} copied`);
          } else {
            context.setStatus(statusSummary(res, "Copilot login started"));
          }
          return;
        }
        if (action === "sign-out") {
          const res = await requestCopilot<unknown>("sign-out");
          clearCompletion();
          context.setStatus(statusSummary(res, "Copilot logged out"));
          return;
        }
        if (action === "status") {
          const res = await requestCopilot<unknown>("status");
          context.setStatus(statusSummary(res, "Copilot status checked"));
          return;
        }
        if (action === "quota") {
          const res = await requestCopilot<unknown>("quota");
          context.setStatus(statusSummary(res, "Copilot quota checked"));
          return;
        }
        if (action === "trigger") {
          clearCompletion();
          await requestCompletion();
          if (!visible) context.setStatus("Copilot: no suggestion");
          return;
        }
        if (action === "log") {
          if (!logRecording) {
            const res = await requestCopilot<unknown>("log", { record: true });
            logRecording = true;
            context.setStatus(statusSummary(res, "Copilot log recording started"));
            return;
          }
          const res = await requestCopilot<unknown>("log", { record: false });
          logRecording = false;
          await copyLog(res);
          context.setStatus("Copilot logs copied");
        }
      } catch (err) {
        context.setStatus(err instanceof Error ? `Copilot: ${err.message}` : "Copilot action failed");
      }
    })();
  }

  cleanups.push(context.onKeyDown(handleKey));
  cleanups.push(context.onAction(runAction));
  cleanups.push(context.onSettingsChange((next) => {
    settings = normalizeSettings(next);
    clearCompletion();
    lastScheduleKey = "";
    scheduleIfChanged();
  }));
  cleanups.push(context.onChange(handleDocumentChange));
  cleanups.push(context.onDocumentEvent("beforeinput", consumeJumpBeforeInput, { capture: true }));
  context.host.addEventListener("aaronnote:copilot-host-key", handleHostKeyEvent);
  cleanups.push(() => context.host.removeEventListener("aaronnote:copilot-host-key", handleHostKeyEvent));
  if (context.onSelectionChange) cleanups.push(context.onSelectionChange(handleEditorStateChange));
  else cleanups.push(context.onDocumentEvent("selectionchange", handleEditorStateChange));
  if (context.onVimModeChange) cleanups.push(context.onVimModeChange(handleEditorStateChange));
  if (context.onActiveChange) cleanups.push(context.onActiveChange(handleEditorStateChange));
  if (context.onFileChange) cleanups.push(context.onFileChange(handleFileChange));
  cleanups.push(context.onDocumentEvent("scroll", () => renderCompletion(), { capture: true }));
  const handleHostFocusIn = () => {
    void notifyFocus("focusin");
    scheduleIfChanged();
  };
  const handleHostFocusOut = (event: FocusEvent) => {
    if (event.relatedTarget instanceof Node && context.host.contains(event.relatedTarget)) return;
    notifyBlur("focusout");
  };
  const handleWindowFocus = () => {
    void notifyFocus("window-focus");
    scheduleIfChanged();
  };
  const handleWindowBlur = () => notifyBlur("window-blur");
  const handlePageHide = () => notifyClose("pagehide");
  context.host.addEventListener("focusin", handleHostFocusIn);
  context.host.addEventListener("focusout", handleHostFocusOut);
  cleanups.push(() => {
    context.host.removeEventListener("focusin", handleHostFocusIn);
    context.host.removeEventListener("focusout", handleHostFocusOut);
  });
  window.addEventListener("focus", handleWindowFocus);
  window.addEventListener("blur", handleWindowBlur);
  window.addEventListener("pagehide", handlePageHide);
  cleanups.push(context.onDocumentEvent("visibilitychange", () => {
    if (document.hidden) notifyBlur("visibility-hidden");
    else {
      void notifyFocus("visibility-visible");
      scheduleIfChanged();
    }
  }));
  window.addEventListener("resize", renderCompletion);
  cleanups.push(() => {
    window.removeEventListener("resize", renderCompletion);
    window.removeEventListener("focus", handleWindowFocus);
    window.removeEventListener("blur", handleWindowBlur);
    window.removeEventListener("pagehide", handlePageHide);
  });

  scheduleIfChanged();

  return () => {
    window.clearTimeout(timer);
    window.clearTimeout(jumpTimer);
    notifyClose("dispose");
    cleanups.splice(0).forEach((cleanup) => cleanup());
    jumpHint.remove();
    ghost.remove();
    style.remove();
  };
}
