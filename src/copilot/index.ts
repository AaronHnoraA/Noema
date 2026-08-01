type Rect = { left: number; top: number; bottom: number };
type EditorLike = {
  getMarkdown(): string;
  getMarkdownLength?: () => number;
  markdownBetween?: (from: number, to: number) => string;
  getMarkdownSelection(): { from: number; to: number };
  getSelection?: () => { from: number; to: number };
  insertText(text: string, deleteBefore?: number): { from: number; to: number };
  cursorContext(maxChars?: number): { before?: string; after?: string; rect: Rect | null };
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
  onKeyDown: (handler: (event: KeyboardEvent) => boolean) => () => void;
  onAction: (handler: (action: string) => void) => () => void;
  onSettingsChange: (handler: (settings: PluginSettings) => void) => () => void;
  getSettings: () => PluginSettings;
  isActive?: () => boolean;
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
};
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

function primaryOnly(event: KeyboardEvent): boolean {
  const windowsDesktop = window.noemaDesktop?.platform === "win32";
  const primary = windowsDesktop
    ? event.ctrlKey && !event.metaKey
    : (event.metaKey && !event.ctrlKey)
      || (!/Mac/.test(navigator.platform) && event.ctrlKey && !event.metaKey);
  return primary && !event.altKey;
}

function toCharShortcut(event: KeyboardEvent): boolean {
  if (!event.shiftKey) return false;
  return toCharKeys.has(event.key)
    || event.key === "]"
    || event.code === "BracketRight";
}

function printableKey(event: KeyboardEvent): string {
  if (event.metaKey || event.ctrlKey || event.altKey) return "";
  if (event.key.length !== 1) return "";
  return event.key;
}

function nextWordLength(text: string): number {
  if (!text) return 0;
  if (text[0] === "\n") {
    const match = text.match(/^\n[ \t]*/);
    return match?.[0].length ?? 1;
  }
  let i = 0;
  while (i < text.length && /[ \t]/.test(text[i] ?? "")) i++;
  if (i > 0) return i;
  while (i < text.length && /[A-Za-z0-9_$-]/.test(text[i] ?? "")) i++;
  return i > 0 ? i : 1;
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

  const style = document.createElement("style");
  style.textContent = `
.aaronnote-copilot-ghost {
  position: fixed;
  z-index: 80;
  pointer-events: none;
  color: color-mix(in srgb, currentColor 38%, transparent);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
  max-width: calc(100vw - 24px);
  overflow: hidden;
  font: 15px/1.6 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
}
.aaronnote-copilot-ghost--lean {
  color: rgb(156 199 255 / 68%);
  text-shadow: 0 1px 2px rgb(0 0 0 / 46%);
}
`;
  document.head.appendChild(style);

  let timer = 0;
  let seq = 0;
  let accepting = false;
  let pendingToChar = false;
  let visible: VisibleCompletion | null = null;
  let settings = normalizeSettings(context.getSettings());
  let lastScheduleKey = "";
  let focusState: "focused" | "blurred" | "closed" = "blurred";
  let focusedFile = "";
  const cleanups: Array<() => void> = [];

  function clearCompletion(): void {
    visible = null;
    pendingToChar = false;
    ghost.hidden = true;
  }

  function renderCompletion(): void {
    if (!visible) {
      ghost.hidden = true;
      return;
    }
    const text = visibleText(visible);
    if (!text) {
      clearCompletion();
      return;
    }
    const rect = context.editor.cursorContext(1600).rect;
    if (!rect) {
      ghost.hidden = true;
      return;
    }
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const margin = 12;
    const minWidth = Math.min(160, Math.max(80, viewportWidth - margin * 2));
    const left = viewportWidth > 0
      ? Math.min(Math.max(margin, rect.left), Math.max(margin, viewportWidth - minWidth - margin))
      : Math.max(0, rect.left);
    const top = viewportHeight > 0
      ? Math.min(Math.max(0, rect.top), Math.max(0, viewportHeight - 32))
      : Math.max(0, rect.top);
    ghost.textContent = text.split("\n", 1)[0] || " ";
    ghost.style.left = `${left}px`;
    ghost.style.top = `${top}px`;
    ghost.style.maxWidth = viewportWidth > 0 ? `${Math.max(80, viewportWidth - left - margin)}px` : "";
    ghost.style.maxHeight = viewportHeight > 0 ? `${Math.max(32, viewportHeight - top - margin)}px` : "";
    ghost.hidden = false;
  }

  function requestKey(): string {
    const selection = activeSelection(context.editor);
    const cursor = context.editor.cursorContext(160);
    return [
      context.currentFile(),
      selection.from,
      selection.to,
      cursor.before?.slice(-80) ?? "",
      cursor.after?.slice(0, 80) ?? "",
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
    clearCompletion();
    void requestCopilot("blur", clientBody({ file, reason, active: false })).catch(() => {});
  }

  function notifyClose(reason = "close"): void {
    if (focusState === "closed") return;
    const file = focusedFile || context.currentFile();
    focusState = "closed";
    focusedFile = "";
    clearCompletion();
    void requestCopilot("close", clientBody({ file, reason, active: false })).catch(() => {});
  }

  function scheduleKey(): string {
    const selection = activeSelection(context.editor);
    return [
      context.currentFile(),
      context.vimMode(),
      selection.from,
      selection.to,
    ].join("\0");
  }

  function eligible(): boolean {
    if (!eligibleShell()) return false;
    const selection = activeSelection(context.editor);
    if (selection.from !== selection.to) return false;
    return !hasBlockingTextAfterCursorOnLine(context.editor.cursorContext(512).after);
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
      clearCompletion();
      return;
    }
    const key = scheduleKey();
    if (key === lastScheduleKey && !visible) return;
    lastScheduleKey = key;
    schedule();
  }

  async function requestCompletion(): Promise<void> {
    if (!eligible()) return;
    await notifyFocus("inline");
    if (!eligible()) return;
    const fullOffset = completionOffset(context.editor);
    const requestDoc = completionRequestDocumentFromEditor(context.editor, fullOffset, settings.largeBufferThreshold);
    if (!eligible()) return;
    const key = requestKey();
    const currentSeq = ++seq;
    try {
      const response = await requestCopilot<InlineResponse>("inline", {
        ...clientBody(),
        file: context.currentFile(),
        content: requestDoc.content,
        offset: requestDoc.offset,
        window: requestDoc.clipped ? { from: requestDoc.from, to: requestDoc.to } : undefined,
      });
      if (currentSeq !== seq || key !== requestKey()) return;
      const choice = response.items?.[0];
      if (!choice?.insertText) {
        clearCompletion();
        if (response.status?.kind === "Error" && response.status.message) {
          context.setStatus(`Copilot: ${response.status.message}`);
        }
        return;
      }
      if (hasBlockingTextAfterCursorOnLine(context.editor.cursorContext(512).after)) {
        clearCompletion();
        return;
      }
      const trimmed = trimmedCompletionInsertText(choice, requestDoc.content, requestDoc.offset);
      if (!trimmed.insertText) {
        clearCompletion();
        return;
      }
      visible = { ...choice, ...trimmed, acceptedLength: 0 };
      renderCompletion();
      void requestCopilot("shown", { item: choice.item }).catch(() => {});
    } catch (err) {
      if (currentSeq !== seq || key !== requestKey()) return;
      if (isSupersededCopilotError(err)) return;
      clearCompletion();
      context.setStatus(err instanceof Error ? `Copilot: ${err.message}` : "Copilot failed");
    }
  }

  function acceptLength(length: number): boolean {
    if (!visible) return false;
    const remaining = visibleText(visible);
    const count = Math.max(0, Math.min(length, remaining.length));
    if (count <= 0) return false;
    const text = remaining.slice(0, count);
    const selection = activeSelection(context.editor);
    if (selection.from !== selection.to) {
      clearCompletion();
      return false;
    }
    accepting = true;
    const insertAndReveal = () => {
      context.editor.insertText(text);
      context.editor.revealCursor();
    };
    if (context.preserveScroll) context.preserveScroll(insertAndReveal);
    else insertAndReveal();
    window.setTimeout(() => {
      accepting = false;
    }, 0);
    visible.acceptedLength += text.length;
    if (visible.acceptedLength >= visible.insertText.length) {
      const item = visible.item;
      clearCompletion();
      void requestCopilot("accept", { item }).catch(() => {});
    } else {
      renderCompletion();
      void requestCopilot("accept", {
        item: visible.item,
        acceptedLength: visible.acceptedBaseLength + visible.acceptedLength,
      }).catch(() => {});
    }
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

  function acceptToChar(ch: string): boolean {
    if (!visible) return false;
    const remaining = visibleText(visible);
    const index = remaining.indexOf(ch);
    if (index < 0) {
      context.setStatus(`Copilot: ${ch} not in completion`);
      pendingToChar = false;
      return true;
    }
    pendingToChar = false;
    return acceptLength(index + ch.length);
  }

  function handleKey(event: KeyboardEvent): boolean {
    if (!targetInHost(context.host, event.target)) return false;
    if (pendingToChar) {
      if (event.key === "Escape") {
        pendingToChar = false;
        context.setStatus("Copilot to-char canceled");
        event.preventDefault();
        return true;
      }
      const ch = printableKey(event);
      if (!ch) return false;
      event.preventDefault();
      return acceptToChar(ch);
    }
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
        pendingToChar = true;
        context.setStatus("Copilot to char");
        event.preventDefault();
        return true;
      }
      const handled = context.jumpSnippetNext() || context.forwardDelimiter();
      if (handled) event.preventDefault();
      return handled;
    }
    return false;
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
    scheduleIfChanged();
  }));
  cleanups.push(context.onChange(() => {
    if (accepting) return;
    clearCompletion();
    lastScheduleKey = "";
    scheduleIfChanged();
  }));
  cleanups.push(context.onDocumentEvent("selectionchange", () => {
    if (accepting) return;
    clearCompletion();
    scheduleIfChanged();
  }));
  cleanups.push(context.onDocumentEvent("mouseup", scheduleIfChanged));
  cleanups.push(context.onDocumentEvent("keyup", scheduleIfChanged));
  cleanups.push(context.onDocumentEvent("scroll", () => renderCompletion(), { capture: true }));
  const handleHostFocusIn = () => { void notifyFocus("focusin"); };
  const handleHostFocusOut = () => notifyBlur("focusout");
  const handleWindowFocus = () => { void notifyFocus("window-focus"); };
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
    else void notifyFocus("visibility-visible");
  }));
  window.addEventListener("resize", renderCompletion);
  cleanups.push(() => {
    window.removeEventListener("resize", renderCompletion);
    window.removeEventListener("focus", handleWindowFocus);
    window.removeEventListener("blur", handleWindowBlur);
    window.removeEventListener("pagehide", handlePageHide);
  });

  schedule();

  return () => {
    window.clearTimeout(timer);
    notifyClose("dispose");
    cleanups.splice(0).forEach((cleanup) => cleanup());
    ghost.remove();
    style.remove();
  };
}
