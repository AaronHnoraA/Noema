import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { setupCopilot } from "../src/copilot/index.ts";

class FakeEditor {
  markdown: string;
  selection: { from: number; to: number };
  cursorBefore = "";
  cursorAfter = "";
  insertions: string[] = [];
  getMarkdownCalls = 0;
  cursorContextCalls = 0;
  revealCursorCalls = 0;

  constructor(markdown: string) {
    this.markdown = markdown;
    this.selection = { from: markdown.length, to: markdown.length };
  }

  getMarkdown(): string {
    this.getMarkdownCalls++;
    return this.markdown;
  }

  getMarkdownLength(): number {
    return this.markdown.length;
  }

  markdownBetween(from: number, to: number): string {
    return this.markdown.slice(from, to);
  }

  getMarkdownSelection(): { from: number; to: number } {
    return this.selection;
  }

  insertText(text: string): { from: number; to: number } {
    const from = this.selection.from;
    const to = this.selection.to;
    this.insertions.push(text);
    this.markdown = `${this.markdown.slice(0, from)}${text}${this.markdown.slice(to)}`;
    this.selection = { from: from + text.length, to: from + text.length };
    return { from, to: from + text.length };
  }

  cursorContext(): { before: string; after: string; rect: { left: number; top: number; bottom: number } } {
    this.cursorContextCalls++;
    return { before: this.cursorBefore, after: this.cursorAfter, rect: { left: 0, top: 0, bottom: 20 } };
  }

  revealCursor(): void {
    this.revealCursorCalls++;
  }
}

function waitForMicrotasks(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function installNativeCopilot(handler: (action: string, body: unknown) => Promise<unknown>): () => void {
  const target = window as Window & { aaronnoteApi?: { copilot?: { request?: (action: string, body?: unknown) => Promise<unknown> } } };
  const oldApi = target.aaronnoteApi;
  target.aaronnoteApi = {
    ...(oldApi ?? {}),
    copilot: {
      ...(oldApi?.copilot ?? {}),
      request: handler,
    },
  };
  return () => {
    if (oldApi) target.aaronnoteApi = oldApi;
    else delete target.aaronnoteApi;
  };
}

type CopilotHarness = ReturnType<typeof createCopilotHarness>;

function createCopilotHarness(options: {
  markdown?: string;
  cursor?: number;
  file?: string;
  idleDelayMs?: number;
  response?: (action: string, body: Record<string, unknown>) => Promise<unknown>;
  mode?: "insert" | "normal" | "visual" | "visual-line";
  active?: boolean;
  isCursorInTexSource?: () => boolean;
  texSourceRangeAtCursor?: () => { from: number; to: number } | null;
  jumpSnippetNext?: () => boolean;
  jumpSnippetPrevious?: () => boolean;
  forwardDelimiter?: () => boolean;
  backwardDelimiter?: () => boolean;
} = {}) {
  const host = document.createElement("div");
  const target = document.createElement("button");
  const secondaryTarget = document.createElement("button");
  host.append(target, secondaryTarget);
  document.body.appendChild(host);
  const editor = new FakeEditor(options.markdown ?? "prefix");
  const cursor = Math.max(0, Math.min(options.cursor ?? editor.markdown.length, editor.markdown.length));
  editor.selection = { from: cursor, to: cursor };
  editor.cursorBefore = editor.markdown.slice(0, cursor);
  editor.cursorAfter = editor.markdown.slice(cursor);
  let mode = options.mode ?? "insert";
  let active = options.active ?? true;
  let file = options.file ?? "/tmp/harness.md";
  const handlers: {
    key?: (event: KeyboardEvent) => boolean;
    action?: (action: string) => void;
    change?: () => void;
    selection?: () => void;
    vimMode?: () => void;
    active?: () => void;
    file?: () => void;
  } = {};
  const requests: Array<{ action: string; body: Record<string, unknown> }> = [];
  const response = options.response ?? (async (action: string, body: Record<string, unknown>) => {
    if (action !== "inline") return { ok: true };
    const content = String(body.content || "");
    const offset = Number(body.offset) || 0;
    return {
      items: [{
        insertText: `${content.slice(0, offset)}Stable`,
        range: { from: 0, to: offset },
        item: { insertText: `${content.slice(0, offset)}Stable` },
      }],
    };
  });
  const restoreApi = installNativeCopilot(async (action, body) => {
    const record = { action, body: (body ?? {}) as Record<string, unknown> };
    requests.push(record);
    return response(action, record.body);
  });
  const cleanup = setupCopilot({
    editor,
    host,
    currentFile: () => file,
    clientId: () => "harness-pane",
    vimMode: () => mode,
    setStatus: () => {},
    onChange: (handler: () => void) => {
      handlers.change = handler;
      return () => { delete handlers.change; };
    },
    onSelectionChange: (handler: () => void) => {
      handlers.selection = handler;
      return () => { delete handlers.selection; };
    },
    onVimModeChange: (handler: () => void) => {
      handlers.vimMode = handler;
      return () => { delete handlers.vimMode; };
    },
    onActiveChange: (handler: () => void) => {
      handlers.active = handler;
      return () => { delete handlers.active; };
    },
    onFileChange: (handler: () => void) => {
      handlers.file = handler;
      return () => { delete handlers.file; };
    },
    onKeyDown: (handler: (event: KeyboardEvent) => boolean) => {
      handlers.key = handler;
      return () => { delete handlers.key; };
    },
    onAction: (handler: (action: string) => void) => {
      handlers.action = handler;
      return () => { delete handlers.action; };
    },
    onSettingsChange: () => () => {},
    getSettings: () => ({ idleDelayMs: options.idleDelayMs ?? 999_999, largeBufferThresholdKb: 512 }),
    isActive: () => active,
    isCursorInTexSource: options.isCursorInTexSource,
    texSourceRangeAtCursor: options.texSourceRangeAtCursor,
    onDocumentEvent: (type, handler, eventOptions) => {
      document.addEventListener(type, handler, eventOptions);
      return () => document.removeEventListener(type, handler, eventOptions);
    },
    jumpSnippetNext: options.jumpSnippetNext ?? (() => false),
    jumpSnippetPrevious: options.jumpSnippetPrevious ?? (() => false),
    forwardDelimiter: options.forwardDelimiter ?? (() => false),
    backwardDelimiter: options.backwardDelimiter ?? (() => false),
  });
  target.addEventListener("keydown", (event) => { handlers.key?.(event); });
  target.focus();

  return {
    host,
    target,
    secondaryTarget,
    editor,
    handlers,
    requests,
    ghost: () => document.querySelector<HTMLElement>(".aaronnote-copilot-ghost"),
    async trigger() {
      handlers.action?.("trigger");
      await waitForMicrotasks();
      await waitForMicrotasks();
    },
    key(init: KeyboardEventInit) {
      const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
      target.dispatchEvent(event);
      return event;
    },
    beforeInput(data: string | null, inputType = "insertText") {
      const event = new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        data,
        inputType,
      });
      target.dispatchEvent(event);
      return event;
    },
    hostKey(detail: {
      key: string;
      code?: string;
      text?: string;
      metaKey?: boolean;
      ctrlKey?: boolean;
      altKey?: boolean;
      shiftKey?: boolean;
      isComposing?: boolean;
    }) {
      const event = new CustomEvent("aaronnote:copilot-host-key", {
        bubbles: true,
        cancelable: true,
        detail: {
          metaKey: false,
          ctrlKey: false,
          altKey: false,
          shiftKey: false,
          ...detail,
        },
      });
      host.dispatchEvent(event);
      return event;
    },
    type(text: string) {
      const { from, to } = editor.selection;
      editor.markdown = `${editor.markdown.slice(0, from)}${text}${editor.markdown.slice(to)}`;
      editor.selection = { from: from + text.length, to: from + text.length };
      editor.cursorBefore = editor.markdown.slice(0, editor.selection.to);
      editor.cursorAfter = editor.markdown.slice(editor.selection.to);
      handlers.change?.();
      handlers.selection?.();
    },
    setMode(next: typeof mode) {
      mode = next;
      handlers.vimMode?.();
    },
    setActive(next: boolean) {
      active = next;
      handlers.active?.();
    },
    setFile(next: string) {
      file = next;
      handlers.file?.();
    },
    dispose() {
      cleanup();
      restoreApi();
      host.remove();
    },
  };
}

async function visibleHarness(options: Parameters<typeof createCopilotHarness>[0] = {}): Promise<CopilotHarness> {
  const harness = createCopilotHarness(options);
  await harness.trigger();
  expect(harness.ghost()?.hidden).toBe(false);
  return harness;
}

describe("copilot plugin insertion", () => {
  test("accepting a suggestion inserts at the cursor instead of replacing the LSP range", async () => {
    const host = document.createElement("div");
    const target = document.createElement("button");
    host.appendChild(target);
    document.body.appendChild(host);

    const editor = new FakeEditor("prefix");
    const handlers: {
      key?: (event: KeyboardEvent) => boolean;
      action?: (action: string) => void;
    } = {};

    const restoreApi = installNativeCopilot(async (action) => {
      if (action === "inline") {
        return {
          items: [{
            insertText: "prefixSuffix",
            range: { from: 0, to: editor.markdown.length },
            item: { insertText: "prefixSuffix" },
          }],
        };
      }
      return { ok: true };
    });

    const cleanup = setupCopilot({
      editor,
      host,
      currentFile: () => "/tmp/copilot.md",
      vimMode: () => "insert",
      setStatus: () => {},
      onChange: () => () => {},
      onKeyDown: (handler: (event: KeyboardEvent) => boolean) => {
        handlers.key = handler;
        return () => {
          delete handlers.key;
        };
      },
      onAction: (handler: (action: string) => void) => {
        handlers.action = handler;
        return () => {
          delete handlers.action;
        };
      },
      onSettingsChange: () => () => {},
      getSettings: () => ({ idleDelayMs: 999_999, largeBufferThresholdKb: 512 }),
      onDocumentEvent: () => () => {},
      jumpSnippetNext: () => false,
      jumpSnippetPrevious: () => false,
      forwardDelimiter: () => false,
      backwardDelimiter: () => false,
    });

    try {
      target.focus();
      handlers.action?.("trigger");
      await waitForMicrotasks();
      await waitForMicrotasks();
      expect(document.querySelector(".aaronnote-copilot-ghost")?.textContent).toBe("Suffix");

      target.addEventListener("keydown", (event) => {
        handlers.key?.(event);
      });
      target.dispatchEvent(new KeyboardEvent("keydown", {
        key: "]",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }));

      expect(editor.insertions).toEqual(["Suffix"]);
      expect(editor.markdown).toBe("prefixSuffix");
    } finally {
      cleanup();
      restoreApi();
      host.remove();
    }
  });

  test("cmd-right-bracket accepts visible copilot text before snippet jumping", async () => {
    const host = document.createElement("div");
    const target = document.createElement("button");
    host.appendChild(target);
    document.body.appendChild(host);

    const editor = new FakeEditor("prefix");
    const handlers: {
      key?: (event: KeyboardEvent) => boolean;
      action?: (action: string) => void;
    } = {};
    let jumpedSnippet = false;

    const restoreApi = installNativeCopilot(async (action) => {
      if (action === "inline") {
        return {
          items: [{
            insertText: "prefixTopLevel",
            range: { from: 0, to: editor.markdown.length },
            item: { insertText: "prefixTopLevel" },
          }],
        };
      }
      return { ok: true };
    });

    const cleanup = setupCopilot({
      editor,
      host,
      currentFile: () => "/tmp/copilot.md",
      vimMode: () => "insert",
      setStatus: () => {},
      onChange: () => () => {},
      onKeyDown: (handler: (event: KeyboardEvent) => boolean) => {
        handlers.key = handler;
        return () => {
          delete handlers.key;
        };
      },
      onAction: (handler: (action: string) => void) => {
        handlers.action = handler;
        return () => {
          delete handlers.action;
        };
      },
      onSettingsChange: () => () => {},
      getSettings: () => ({ idleDelayMs: 999_999, largeBufferThresholdKb: 512 }),
      onDocumentEvent: () => () => {},
      jumpSnippetNext: () => {
        jumpedSnippet = true;
        return true;
      },
      jumpSnippetPrevious: () => false,
      forwardDelimiter: () => false,
      backwardDelimiter: () => false,
    });

    try {
      target.focus();
      handlers.action?.("trigger");
      await waitForMicrotasks();
      await waitForMicrotasks();

      target.addEventListener("keydown", (event) => {
        handlers.key?.(event);
      });
      target.dispatchEvent(new KeyboardEvent("keydown", {
        key: "]",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }));

      expect(jumpedSnippet).toBe(false);
      expect(editor.insertions).toEqual(["TopLevel"]);
      expect(editor.markdown).toBe("prefixTopLevel");
    } finally {
      cleanup();
      restoreApi();
      host.remove();
    }
  });

  test("does not capture Cmd-brackets while the host marks Copilot inactive", () => {
    const host = document.createElement("div");
    const target = document.createElement("button");
    host.append(target);
    document.body.append(host);
    const editor = new FakeEditor("math");
    let keyHandler: ((event: KeyboardEvent) => boolean) | undefined;
    let snippetJumps = 0;
    let delimiterJumps = 0;
    const restoreApi = installNativeCopilot(async () => ({ ok: true }));

    const cleanup = setupCopilot({
      editor,
      host,
      currentFile: () => "/tmp/copilot.md",
      vimMode: () => "insert",
      setStatus: () => {},
      onChange: () => () => {},
      onKeyDown: (handler: (event: KeyboardEvent) => boolean) => {
        keyHandler = handler;
        return () => { keyHandler = undefined; };
      },
      onAction: () => () => {},
      onSettingsChange: () => () => {},
      getSettings: () => ({ idleDelayMs: 999_999, largeBufferThresholdKb: 512 }),
      isActive: () => false,
      onDocumentEvent: () => () => {},
      jumpSnippetNext: () => { snippetJumps += 1; return true; },
      jumpSnippetPrevious: () => false,
      forwardDelimiter: () => { delimiterJumps += 1; return true; },
      backwardDelimiter: () => false,
    });

    try {
      target.addEventListener("keydown", (event) => { keyHandler?.(event); });
      target.focus();
      const event = new KeyboardEvent("keydown", {
        key: "]",
        code: "BracketRight",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      target.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(false);
      expect(snippetJumps).toBe(0);
      expect(delimiterJumps).toBe(0);
    } finally {
      cleanup();
      restoreApi();
      host.remove();
    }
  });

  test("cmd-right-bracket accepts visible copilot text inside preserveScroll", async () => {
    const host = document.createElement("div");
    const target = document.createElement("button");
    host.appendChild(target);
    document.body.appendChild(host);

    const editor = new FakeEditor("prefix");
    const handlers: {
      key?: (event: KeyboardEvent) => boolean;
      action?: (action: string) => void;
    } = {};
    const preserveEvents: string[] = [];

    const restoreApi = installNativeCopilot(async (action) => {
      if (action === "inline") {
        return {
          items: [{
            insertText: "prefixSuffix",
            range: { from: 0, to: editor.markdown.length },
            item: { insertText: "prefixSuffix" },
          }],
        };
      }
      return { ok: true };
    });

    const cleanup = setupCopilot({
      editor,
      host,
      currentFile: () => "/tmp/copilot.md",
      vimMode: () => "insert",
      setStatus: () => {},
      onChange: () => () => {},
      onKeyDown: (handler: (event: KeyboardEvent) => boolean) => {
        handlers.key = handler;
        return () => {
          delete handlers.key;
        };
      },
      onAction: (handler: (action: string) => void) => {
        handlers.action = handler;
        return () => {
          delete handlers.action;
        };
      },
      onSettingsChange: () => () => {},
      getSettings: () => ({ idleDelayMs: 999_999, largeBufferThresholdKb: 512 }),
      onDocumentEvent: () => () => {},
      preserveScroll: (update) => {
        preserveEvents.push("before");
        update();
        preserveEvents.push("after");
      },
      jumpSnippetNext: () => false,
      jumpSnippetPrevious: () => false,
      forwardDelimiter: () => false,
      backwardDelimiter: () => false,
    });

    try {
      target.focus();
      handlers.action?.("trigger");
      await waitForMicrotasks();
      await waitForMicrotasks();

      target.addEventListener("keydown", (event) => {
        handlers.key?.(event);
      });
      target.dispatchEvent(new KeyboardEvent("keydown", {
        key: "]",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }));

      expect(preserveEvents).toEqual(["before", "after"]);
      expect(editor.revealCursorCalls).toBe(1);
      expect(editor.insertions).toEqual(["Suffix"]);
      expect(editor.markdown).toBe("prefixSuffix");
    } finally {
      cleanup();
      restoreApi();
      host.remove();
    }
  });

  test("cmd-shift-right-bracket starts a direct grapheme jump on bracket-key layouts", async () => {
    const host = document.createElement("div");
    const target = document.createElement("button");
    host.appendChild(target);
    document.body.appendChild(host);

    const editor = new FakeEditor("prefix");
    const handlers: {
      key?: (event: KeyboardEvent) => boolean;
      action?: (action: string) => void;
    } = {};

    const restoreApi = installNativeCopilot(async (action) => {
      if (action === "inline") {
        return {
          items: [{
            insertText: "prefixAlphaBeta",
            range: { from: 0, to: editor.markdown.length },
            item: { insertText: "prefixAlphaBeta" },
          }],
        };
      }
      return { ok: true };
    });

    const cleanup = setupCopilot({
      editor,
      host,
      currentFile: () => "/tmp/copilot.md",
      vimMode: () => "insert",
      setStatus: () => {},
      onChange: () => () => {},
      onKeyDown: (handler: (event: KeyboardEvent) => boolean) => {
        handlers.key = handler;
        return () => {
          delete handlers.key;
        };
      },
      onAction: (handler: (action: string) => void) => {
        handlers.action = handler;
        return () => {
          delete handlers.action;
        };
      },
      onSettingsChange: () => () => {},
      getSettings: () => ({ idleDelayMs: 999_999, largeBufferThresholdKb: 512 }),
      onDocumentEvent: () => () => {},
      jumpSnippetNext: () => false,
      jumpSnippetPrevious: () => false,
      forwardDelimiter: () => false,
      backwardDelimiter: () => false,
    });

    try {
      target.focus();
      handlers.action?.("trigger");
      await waitForMicrotasks();
      await waitForMicrotasks();

      target.addEventListener("keydown", (event) => {
        handlers.key?.(event);
      });
      target.dispatchEvent(new KeyboardEvent("keydown", {
        key: "]",
        code: "BracketRight",
        metaKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }));
      expect(document.querySelector(".aaronnote-copilot-jump-target")).toBeFalsy();
      target.dispatchEvent(new KeyboardEvent("keydown", {
        key: "B",
        bubbles: true,
        cancelable: true,
      }));
      const beta = [...document.querySelectorAll<HTMLElement>(".aaronnote-copilot-jump-target")]
        .find((candidate) => candidate.textContent === "B");
      expect(beta?.dataset.copilotJumpLabel).toBeTruthy();
      for (const key of beta!.dataset.copilotJumpLabel!) {
        target.dispatchEvent(new KeyboardEvent("keydown", {
          key,
          bubbles: true,
          cancelable: true,
        }));
      }

      expect(editor.insertions).toEqual(["AlphaB"]);
      expect(editor.markdown).toBe("prefixAlphaB");
    } finally {
      cleanup();
      restoreApi();
      host.remove();
    }
  });

  test("document eligibility uses the active cursor tail instead of markdown line tail", async () => {
    const host = document.createElement("div");
    const target = document.createElement("button");
    host.appendChild(target);
    document.body.appendChild(host);

    const editor = new FakeEditor("prefix suffix");
    editor.selection = { from: "prefix".length, to: "prefix".length };
    editor.cursorAfter = "";
    const handlers: {
      action?: (action: string) => void;
    } = {};
    let inlineRequests = 0;

    const restoreApi = installNativeCopilot(async (action) => {
      if (action === "inline") {
        inlineRequests += 1;
        return {
          items: [{
            insertText: "Suffix",
            range: { from: editor.selection.to, to: editor.selection.to },
            item: { insertText: "Suffix" },
          }],
        };
      }
      return { ok: true };
    });

    const cleanup = setupCopilot({
      editor,
      host,
      currentFile: () => "/tmp/document.md",
      vimMode: () => "insert",
      setStatus: () => {},
      onChange: () => () => {},
      onKeyDown: () => () => {},
      onAction: (handler: (action: string) => void) => {
        handlers.action = handler;
        return () => {
          delete handlers.action;
        };
      },
      onSettingsChange: () => () => {},
      getSettings: () => ({ idleDelayMs: 999_999, largeBufferThresholdKb: 512 }),
      onDocumentEvent: () => () => {},
      jumpSnippetNext: () => false,
      jumpSnippetPrevious: () => false,
      forwardDelimiter: () => false,
      backwardDelimiter: () => false,
    });

    try {
      target.focus();
      handlers.action?.("trigger");
      await waitForMicrotasks();
      await waitForMicrotasks();
      expect(inlineRequests).toBe(1);
      expect(document.querySelector(".aaronnote-copilot-ghost")?.textContent).toBe("Suffix");
    } finally {
      cleanup();
      restoreApi();
      host.remove();
    }
  });

  test("allows inline suggestions before closing punctuation", async () => {
    const host = document.createElement("div");
    const target = document.createElement("button");
    host.appendChild(target);
    document.body.appendChild(host);

    const editor = new FakeEditor("call()");
    editor.selection = { from: "call(".length, to: "call(".length };
    editor.cursorAfter = ")";
    const handlers: {
      action?: (action: string) => void;
    } = {};
    let inlineRequests = 0;

    const restoreApi = installNativeCopilot(async (action) => {
      if (action === "inline") {
        inlineRequests += 1;
        return {
          items: [{
            insertText: "value",
            range: { from: editor.selection.to, to: editor.selection.to },
            item: { insertText: "value" },
          }],
        };
      }
      return { ok: true };
    });

    const cleanup = setupCopilot({
      editor,
      host,
      currentFile: () => "/tmp/punctuation.md",
      vimMode: () => "insert",
      setStatus: () => {},
      onChange: () => () => {},
      onKeyDown: () => () => {},
      onAction: (handler: (action: string) => void) => {
        handlers.action = handler;
        return () => {
          delete handlers.action;
        };
      },
      onSettingsChange: () => () => {},
      getSettings: () => ({ idleDelayMs: 999_999, largeBufferThresholdKb: 512 }),
      onDocumentEvent: () => () => {},
      jumpSnippetNext: () => false,
      jumpSnippetPrevious: () => false,
      forwardDelimiter: () => false,
      backwardDelimiter: () => false,
    });

    try {
      target.focus();
      handlers.action?.("trigger");
      await waitForMicrotasks();
      await waitForMicrotasks();
      expect(inlineRequests).toBe(1);
      expect(document.querySelector(".aaronnote-copilot-ghost")?.textContent).toBe("value");
    } finally {
      cleanup();
      restoreApi();
      host.remove();
    }
  });

  test("suppresses inline suggestions before word text", async () => {
    const host = document.createElement("div");
    const target = document.createElement("button");
    host.appendChild(target);
    document.body.appendChild(host);

    const editor = new FakeEditor("call(value)");
    editor.selection = { from: "call(".length, to: "call(".length };
    editor.cursorAfter = "value)";
    const handlers: {
      action?: (action: string) => void;
    } = {};
    let inlineRequests = 0;

    const restoreApi = installNativeCopilot(async (action) => {
      if (action === "inline") inlineRequests += 1;
      return { ok: true, items: [] };
    });

    const cleanup = setupCopilot({
      editor,
      host,
      currentFile: () => "/tmp/word-tail.md",
      vimMode: () => "insert",
      setStatus: () => {},
      onChange: () => () => {},
      onKeyDown: () => () => {},
      onAction: (handler: (action: string) => void) => {
        handlers.action = handler;
        return () => {
          delete handlers.action;
        };
      },
      onSettingsChange: () => () => {},
      getSettings: () => ({ idleDelayMs: 999_999, largeBufferThresholdKb: 512 }),
      onDocumentEvent: () => () => {},
      jumpSnippetNext: () => false,
      jumpSnippetPrevious: () => false,
      forwardDelimiter: () => false,
      backwardDelimiter: () => false,
    });

    try {
      target.focus();
      handlers.action?.("trigger");
      await waitForMicrotasks();
      await waitForMicrotasks();
      expect(inlineRequests).toBe(0);
      expect((document.querySelector(".aaronnote-copilot-ghost") as HTMLElement | null)?.hidden).toBe(true);
    } finally {
      cleanup();
      restoreApi();
      host.remove();
    }
  });

  test("allows inline suggestions before word text inside revealed TeX source", async () => {
    const host = document.createElement("div");
    const target = document.createElement("button");
    host.appendChild(target);
    document.body.appendChild(host);

    const editor = new FakeEditor("\\(xy\\)");
    editor.selection = { from: "\\(x".length, to: "\\(x".length };
    editor.cursorBefore = "\\(x";
    editor.cursorAfter = "y\\)";
    const handlers: {
      action?: (action: string) => void;
    } = {};
    let inlineRequests = 0;

    const restoreApi = installNativeCopilot(async (action) => {
      if (action === "inline") {
        inlineRequests += 1;
        return {
          items: [{
            insertText: "z",
            range: { from: editor.selection.to, to: editor.selection.to },
            item: { insertText: "z" },
          }],
        };
      }
      return { ok: true };
    });

    const cleanup = setupCopilot({
      editor,
      host,
      currentFile: () => "/tmp/formula.md",
      vimMode: () => "insert",
      setStatus: () => {},
      onChange: () => () => {},
      onKeyDown: () => () => {},
      onAction: (handler: (action: string) => void) => {
        handlers.action = handler;
        return () => {
          delete handlers.action;
        };
      },
      onSettingsChange: () => () => {},
      getSettings: () => ({ idleDelayMs: 999_999, largeBufferThresholdKb: 512 }),
      isCursorInTexSource: () => true,
      onDocumentEvent: () => () => {},
      jumpSnippetNext: () => false,
      jumpSnippetPrevious: () => false,
      forwardDelimiter: () => false,
      backwardDelimiter: () => false,
    });

    try {
      target.focus();
      handlers.action?.("trigger");
      await waitForMicrotasks();
      await waitForMicrotasks();
      expect(inlineRequests).toBe(1);
      expect(document.querySelector(".aaronnote-copilot-ghost")?.textContent).toBe("z");
    } finally {
      cleanup();
      restoreApi();
      host.remove();
    }
  });

  test("preserves existing TeX closing tails while rendering and accepting formula completions", async () => {
    const cases = [
      {
        markdown: "\\(\\frac{x}{}\\)",
        cursor: "\\(\\frac{x}{".length,
        insertText: "\\(\\frac{x}{y}\\)",
        range: { from: 0, to: "\\(\\frac{x}{}\\)".length },
        ghost: "y",
        expected: "\\(\\frac{x}{y}\\)",
      },
      {
        markdown: "\\[\nx\\]\n",
        cursor: "\\[\nx".length,
        insertText: "y\\]",
        range: { from: "\\[\nx".length, to: "\\[\nx\\]".length },
        ghost: "y",
        expected: "\\[\nxy\\]\n",
      },
      {
        markdown: "\\(E=\\)",
        cursor: "\\(E=".length,
        insertText: "\\(E=mc^2\\)",
        range: { from: 0, to: "\\(E=\\)".length },
        ghost: "mc^2",
        expected: "\\(E=mc^2\\)",
      },
    ];

    for (const formula of cases) {
      const harness = createCopilotHarness({
        markdown: formula.markdown,
        cursor: formula.cursor,
        isCursorInTexSource: () => true,
        response: async (action) => action === "inline"
          ? {
              items: [{
                insertText: formula.insertText,
                range: formula.range,
                item: { insertText: formula.insertText },
              }],
            }
          : { ok: true },
      });
      try {
        await harness.trigger();
        expect(harness.ghost()?.hidden).toBe(false);
        expect(harness.ghost()?.textContent).toBe(formula.ghost);
        harness.key({ key: "]", metaKey: true });
        expect(harness.editor.markdown).toBe(formula.expected);
      } finally {
        harness.dispose();
      }
    }
  });

  test("requests formula ghost text through a bounded virtual LaTeX document", async () => {
    const markdown = "\\(E=\\)";
    const harness = createCopilotHarness({
      markdown,
      cursor: "\\(E=".length,
      isCursorInTexSource: () => true,
      texSourceRangeAtCursor: () => ({ from: 2, to: markdown.length - 2 }),
      response: async (action) => action === "inline"
        ? {
            items: [{
              insertText: "E=mc^2",
              range: { from: 0, to: 2 },
              item: { insertText: "E=mc^2" },
            }],
          }
        : { ok: true },
    });
    try {
      await harness.trigger();
      const inline = harness.requests.find((request) => request.action === "inline");
      expect(inline?.body.file).toBe("/tmp/harness.md.noema-copilot.tex");
      expect(inline?.body.sourceFile).toBe("/tmp/harness.md");
      expect(inline?.body.content).toBe("E=");
      expect(inline?.body.offset).toBe(2);
      expect(harness.ghost()?.textContent).toBe("mc^2");

      harness.key({ key: "]", metaKey: true });
      expect(harness.editor.markdown).toBe("\\(E=mc^2\\)");
    } finally {
      harness.dispose();
    }
  });

  test("large documents send only a cursor-local completion window", async () => {
    const host = document.createElement("div");
    const target = document.createElement("button");
    host.appendChild(target);
    document.body.appendChild(host);

    const markdown = `${"a".repeat(2000)}\nneedle`;
    const editor = new FakeEditor(markdown);
    const handlers: {
      action?: (action: string) => void;
    } = {};
    let inlineBody: { content: string; offset: number; window?: { from: number; to: number } } | null = null;

    const restoreApi = installNativeCopilot(async (action, body) => {
      if (action === "inline") {
        inlineBody = body as { content: string; offset: number; window?: { from: number; to: number } };
        return {
          items: [{
            insertText: "needleSuffix",
            range: { from: inlineBody!.offset - "needle".length, to: inlineBody!.offset },
            item: { insertText: "needleSuffix" },
          }],
        };
      }
      return { ok: true };
    });

    const cleanup = setupCopilot({
      editor,
      host,
      currentFile: () => "/tmp/large.md",
      vimMode: () => "insert",
      setStatus: () => {},
      onChange: () => () => {},
      onKeyDown: () => () => {},
      onAction: (handler: (action: string) => void) => {
        handlers.action = handler;
        return () => {
          delete handlers.action;
        };
      },
      onSettingsChange: () => () => {},
      getSettings: () => ({ idleDelayMs: 999_999, largeBufferThresholdKb: 1 }),
      onDocumentEvent: () => () => {},
      jumpSnippetNext: () => false,
      jumpSnippetPrevious: () => false,
      forwardDelimiter: () => false,
      backwardDelimiter: () => false,
    });

    try {
      target.focus();
      handlers.action?.("trigger");
      await waitForMicrotasks();
      await waitForMicrotasks();

      expect(inlineBody).not.toBeNull();
      expect(inlineBody!.content.length).toBeLessThanOrEqual(1024);
      expect(inlineBody!.content).toContain("needle");
      expect(inlineBody!.offset).toBe(inlineBody!.content.indexOf("needle") + "needle".length);
      expect(inlineBody!.window?.from).toBeGreaterThan(0);
      expect(editor.getMarkdownCalls).toBe(0);
      expect(document.querySelector(".aaronnote-copilot-ghost")?.textContent).toBe("Suffix");
    } finally {
      cleanup();
      restoreApi();
      host.remove();
    }
  });

  test("duplicate selectionchange events do not reschedule cursor context work", async () => {
    const host = document.createElement("div");
    const target = document.createElement("button");
    host.appendChild(target);
    document.body.appendChild(host);

    const editor = new FakeEditor("prefix");
    const handlers: {
      selectionchange?: () => void;
    } = {};

    const restoreApi = installNativeCopilot(async () => ({ ok: true, items: [] }));
    const cleanup = setupCopilot({
      editor,
      host,
      currentFile: () => "/tmp/copilot.md",
      vimMode: () => "insert",
      setStatus: () => {},
      onChange: () => () => {},
      onKeyDown: () => () => {},
      onAction: () => () => {},
      onSettingsChange: () => () => {},
      getSettings: () => ({ idleDelayMs: 999_999, largeBufferThresholdKb: 512 }),
      onDocumentEvent: <K extends keyof DocumentEventMap>(type: K, handler: (event: DocumentEventMap[K]) => void) => {
        if (type === "selectionchange") handlers.selectionchange = handler as () => void;
        return () => {
          if (type === "selectionchange") delete handlers.selectionchange;
        };
      },
      jumpSnippetNext: () => false,
      jumpSnippetPrevious: () => false,
      forwardDelimiter: () => false,
      backwardDelimiter: () => false,
    });

    try {
      target.focus();
      const before = editor.cursorContextCalls;
      handlers.selectionchange?.();
      handlers.selectionchange?.();
      handlers.selectionchange?.();
      expect(editor.cursorContextCalls - before).toBe(0);
    } finally {
      cleanup();
      restoreApi();
      host.remove();
    }
  });

  test("sends pane client lifecycle and active metadata with inline requests", async () => {
    const host = document.createElement("div");
    const target = document.createElement("button");
    host.appendChild(target);
    document.body.appendChild(host);

    const editor = new FakeEditor("prefix");
    const handlers: {
      action?: (action: string) => void;
    } = {};
    const requests: Array<{ action: string; body: Record<string, unknown> }> = [];

    const restoreApi = installNativeCopilot(async (action, body) => {
      requests.push({ action, body: body as Record<string, unknown> });
      if (action === "inline") {
        return {
          items: [{
            insertText: "prefixSuffix",
            range: { from: 0, to: editor.markdown.length },
            item: { insertText: "prefixSuffix" },
          }],
        };
      }
      return { ok: true };
    });

    const cleanup = setupCopilot({
      editor,
      host,
      currentFile: () => "/tmp/client.md",
      clientId: () => "pane-a",
      vimMode: () => "insert",
      setStatus: () => {},
      onChange: () => () => {},
      onKeyDown: () => () => {},
      onAction: (handler: (action: string) => void) => {
        handlers.action = handler;
        return () => {
          delete handlers.action;
        };
      },
      onSettingsChange: () => () => {},
      getSettings: () => ({ idleDelayMs: 999_999, largeBufferThresholdKb: 512 }),
      isActive: () => true,
      onDocumentEvent: () => () => {},
      jumpSnippetNext: () => false,
      jumpSnippetPrevious: () => false,
      forwardDelimiter: () => false,
      backwardDelimiter: () => false,
    });

    try {
      target.focus();
      await waitForMicrotasks();
      handlers.action?.("trigger");
      await waitForMicrotasks();
      await waitForMicrotasks();

      const focus = requests.find((request) => request.action === "focus");
      const inline = requests.find((request) => request.action === "inline");
      expect(focus?.body.clientId).toBe("pane-a");
      expect(focus?.body.file).toBe("/tmp/client.md");
      expect(inline?.body.clientId).toBe("pane-a");
      expect(inline?.body.active).toBe(true);
      expect(inline?.body.file).toBe("/tmp/client.md");

      cleanup();
      await waitForMicrotasks();
      const close = requests.find((request) => request.action === "close");
      expect(close?.body.clientId).toBe("pane-a");
      expect(close?.body.active).toBe(false);
    } finally {
      restoreApi();
      host.remove();
    }
  });

  test("ignores superseded inline errors from stale requests", async () => {
    const host = document.createElement("div");
    const target = document.createElement("button");
    host.appendChild(target);
    document.body.appendChild(host);

    const editor = new FakeEditor("prefix");
    const handlers: {
      action?: (action: string) => void;
    } = {};
    const statuses: string[] = [];
    const firstInline = deferred<unknown>();
    let inlineRequests = 0;

    const restoreApi = installNativeCopilot(async (action) => {
      if (action === "inline") {
        inlineRequests += 1;
        if (inlineRequests === 1) return firstInline.promise;
        return {
          items: [{
            insertText: "prefixSuffix",
            range: { from: 0, to: editor.markdown.length },
            item: { insertText: "prefixSuffix" },
          }],
        };
      }
      return { ok: true };
    });

    const cleanup = setupCopilot({
      editor,
      host,
      currentFile: () => "/tmp/superseded.md",
      clientId: () => "pane-a",
      vimMode: () => "insert",
      setStatus: (status: string) => statuses.push(status),
      onChange: () => () => {},
      onKeyDown: () => () => {},
      onAction: (handler: (action: string) => void) => {
        handlers.action = handler;
        return () => {
          delete handlers.action;
        };
      },
      onSettingsChange: () => () => {},
      getSettings: () => ({ idleDelayMs: 999_999, largeBufferThresholdKb: 512 }),
      isActive: () => true,
      onDocumentEvent: () => () => {},
      jumpSnippetNext: () => false,
      jumpSnippetPrevious: () => false,
      forwardDelimiter: () => false,
      backwardDelimiter: () => false,
    });

    try {
      target.focus();
      handlers.action?.("trigger");
      await waitForMicrotasks();
      handlers.action?.("trigger");
      await waitForMicrotasks();
      await waitForMicrotasks();
      expect(document.querySelector(".aaronnote-copilot-ghost")?.textContent).toBe("Suffix");

      firstInline.reject(new Error("jsonrpc-error-code . -32802 Request was superseded by a new request"));
      await waitForMicrotasks();

      expect(document.querySelector(".aaronnote-copilot-ghost")?.textContent).toBe("Suffix");
      expect(statuses.some((status) => status.includes("superseded"))).toBe(false);
    } finally {
      cleanup();
      restoreApi();
      host.remove();
    }
  });

  test("keeps a visible suggestion across duplicate editor state notifications", async () => {
    const harness = await visibleHarness();
    try {
      const inlineBefore = harness.requests.filter((request) => request.action === "inline").length;
      const textBefore = harness.ghost()?.textContent;
      harness.handlers.selection?.();
      harness.handlers.selection?.();
      harness.handlers.selection?.();

      expect(harness.ghost()?.hidden).toBe(false);
      expect(harness.ghost()?.textContent).toBe(textBefore);
      expect(harness.requests.filter((request) => request.action === "inline")).toHaveLength(inlineBefore);
    } finally {
      harness.dispose();
    }
  });

  test("shrinks a matching ghost prefix immediately while its refresh is debounced", async () => {
    const harness = await visibleHarness();
    try {
      expect(harness.ghost()?.textContent).toBe("Stable");
      harness.type("Sta");

      expect(harness.editor.markdown).toBe("prefixSta");
      expect(harness.ghost()?.hidden).toBe(false);
      expect(harness.ghost()?.textContent).toBe("ble");
      expect(harness.requests.filter((request) => request.action === "inline")).toHaveLength(1);
    } finally {
      harness.dispose();
    }
  });

  test("clears a ghost after a non-matching edit and does not report fully typed text as accepted", async () => {
    const mismatch = await visibleHarness();
    try {
      mismatch.type("X");
      expect(mismatch.ghost()?.hidden).toBe(true);
    } finally {
      mismatch.dispose();
    }

    const completed = await visibleHarness();
    try {
      completed.type("Stable");
      expect(completed.ghost()?.hidden).toBe(true);
      expect(completed.requests.some((request) => request.action === "accept")).toBe(false);
    } finally {
      completed.dispose();
    }
  });

  test("does not resurrect an inline response after blur, host deactivation, or a file switch", async () => {
    for (const deactivate of ["blur", "active", "file"] as const) {
      const pending = deferred<unknown>();
      const harness = createCopilotHarness({
        response: async (action) => action === "inline" ? pending.promise : { ok: true },
      });
      try {
        harness.handlers.action?.("trigger");
        await waitForMicrotasks();
        if (deactivate === "blur") window.dispatchEvent(new Event("blur"));
        else if (deactivate === "active") harness.setActive(false);
        else harness.setFile("/tmp/other.md");
        pending.resolve({
          items: [{
            insertText: "prefixLate",
            range: { from: 0, to: "prefix".length },
            item: { insertText: "prefixLate" },
          }],
        });
        await waitForMicrotasks();

        expect(harness.ghost()?.hidden).toBe(true);
      } finally {
        harness.dispose();
      }
    }
  });

  test("mode changes retire the current ghost, while internal focus transfer preserves it", async () => {
    const harness = await visibleHarness();
    try {
      harness.target.dispatchEvent(new FocusEvent("focusout", {
        bubbles: true,
        relatedTarget: harness.secondaryTarget,
      }));
      harness.secondaryTarget.focus();
      expect(harness.ghost()?.hidden).toBe(false);

      harness.setMode("normal");
      expect(harness.ghost()?.hidden).toBe(true);
    } finally {
      harness.dispose();
    }
  });

  test("S-jump waits for a target, narrows multi-key labels, and accepts the chosen occurrence", async () => {
    const suffix = `${"x".repeat(25)}y`;
    const harness = await visibleHarness({
      response: async (action) => action === "inline"
        ? {
            items: [{
              insertText: `prefix${suffix}`,
              range: { from: 0, to: "prefix".length },
              item: { insertText: `prefix${suffix}` },
            }],
          }
        : { ok: true },
    });
    try {
      const shortcut = harness.key({
        key: "]",
        code: "BracketRight",
        metaKey: true,
        shiftKey: true,
        isComposing: true,
      });
      expect(shortcut.defaultPrevented).toBe(true);
      expect(document.querySelector(".aaronnote-copilot-jump-target")).toBeFalsy();
      expect(harness.editor.insertions).toEqual([]);

      const targetKey = harness.key({ key: "x" });
      expect(targetKey.defaultPrevented).toBe(true);
      const targets = [...document.querySelectorAll<HTMLElement>(".aaronnote-copilot-jump-target")];
      expect(targets).toHaveLength(25);
      const target = targets.at(-1);
      const label = target?.dataset.copilotJumpLabel ?? "";
      expect(label.length).toBeGreaterThan(1);

      harness.key({ key: label[0] });
      harness.key({ key: "Backspace" });
      const restored = [...document.querySelectorAll<HTMLElement>(".aaronnote-copilot-jump-target")]
        .at(-1)?.dataset.copilotJumpLabel;
      expect(restored).toBe(label);
      for (const key of label) harness.key({ key });

      expect(harness.editor.insertions).toEqual(["x".repeat(25)]);
      expect(harness.ghost()?.textContent).toBe("y");
    } finally {
      harness.dispose();
    }
  });

  test("active S-jump captures composing-marked target and label keys without weakening normal IME", async () => {
    const harness = await visibleHarness();
    try {
      const ordinaryIme = harness.key({ key: "a", isComposing: true });
      expect(ordinaryIme.defaultPrevented).toBe(false);

      harness.key({ key: "]", code: "BracketRight", metaKey: true, shiftKey: true });
      expect(document.querySelector(".aaronnote-copilot-jump-target")).toBeFalsy();

      const composingTarget = harness.key({ key: "a", isComposing: true });
      expect(composingTarget.defaultPrevented).toBe(true);
      expect(harness.editor.insertions).toEqual([]);
      const target = document.querySelector<HTMLElement>(".aaronnote-copilot-jump-target");
      expect(target?.textContent).toBe("a");

      const pairedTargetInput = harness.beforeInput("a");
      expect(pairedTargetInput.defaultPrevented).toBe(true);
      expect(harness.editor.insertions).toEqual([]);

      const composingLabel = harness.key({
        key: target!.dataset.copilotJumpLabel!,
        isComposing: true,
      });
      expect(composingLabel.defaultPrevented).toBe(true);
      expect(harness.editor.insertions).toEqual(["Sta"]);
      expect(harness.ghost()?.textContent).toBe("ble");

      const pairedLabelInput = harness.beforeInput(target!.dataset.copilotJumpLabel!);
      expect(pairedLabelInput.defaultPrevented).toBe(true);
      expect(harness.editor.insertions).toEqual(["Sta"]);

      harness.key({ key: "]", code: "BracketRight", metaKey: true, shiftKey: true });
      const escape = harness.key({ key: "Escape" });
      expect(escape.defaultPrevented).toBe(true);
      expect(harness.editor.insertions).toEqual(["Sta"]);
      expect(harness.ghost()?.hidden).toBe(false);
      expect(harness.ghost()?.textContent).toBe("ble");
      expect(document.querySelector(".aaronnote-copilot-jump-target")).toBeFalsy();
    } finally {
      harness.dispose();
    }
  });

  test("S-jump consumes xwidget beforeinput targets and host-adapter labels", async () => {
    const harness = await visibleHarness();
    try {
      harness.key({ key: "]", code: "BracketRight", metaKey: true, shiftKey: true });

      const targetInput = harness.beforeInput("a");
      expect(targetInput.defaultPrevented).toBe(true);
      expect(harness.editor.markdown).toBe("prefix");
      const target = document.querySelector<HTMLElement>(".aaronnote-copilot-jump-target");
      expect(target?.textContent).toBe("a");

      const labelInput = harness.hostKey({
        key: target!.dataset.copilotJumpLabel!,
        text: target!.dataset.copilotJumpLabel!,
      });
      expect(labelInput.defaultPrevented).toBe(true);
      expect(harness.editor.insertions).toEqual(["Sta"]);
      expect(harness.editor.markdown).toBe("prefixSta");
      expect(harness.ghost()?.textContent).toBe("ble");
    } finally {
      harness.dispose();
    }
  });

  test("S-jump exposes an armed hint but passes paste and the following text through", async () => {
    const harness = await visibleHarness();
    try {
      harness.key({ key: "]", code: "BracketRight", metaKey: true, shiftKey: true });
      const hint = document.querySelector<HTMLElement>(".aaronnote-copilot-jump-hint");
      expect(hint?.hidden).toBe(false);
      expect(hint?.textContent).toBe("S · target");
      expect(document.querySelector(".aaronnote-copilot-jump-target")).toBeFalsy();

      const paste = harness.beforeInput("pasted text", "insertFromPaste");
      expect(paste.defaultPrevented).toBe(false);
      expect(hint?.hidden).toBe(true);

      const normalText = harness.beforeInput("a");
      expect(normalText.defaultPrevented).toBe(false);
      expect(harness.editor.insertions).toEqual([]);
    } finally {
      harness.dispose();
    }
  });

  test("S-jump cancels on an intervening navigation key and never pays dedupe with the next key", async () => {
    const harness = await visibleHarness();
    try {
      harness.key({ key: "]", code: "BracketRight", metaKey: true, shiftKey: true });
      const arrow = harness.key({ key: "ArrowLeft" });
      expect(arrow.defaultPrevented).toBe(false);
      expect(document.querySelector<HTMLElement>(".aaronnote-copilot-jump-hint")?.hidden).toBe(true);

      const text = harness.beforeInput("}");
      expect(text.defaultPrevented).toBe(false);
      expect(harness.editor.insertions).toEqual([]);
    } finally {
      harness.dispose();
    }
  });

  test("a new physical key retires the completed S-jump paired-input expectation", async () => {
    const harness = await visibleHarness();
    try {
      harness.key({ key: "]", code: "BracketRight", metaKey: true, shiftKey: true });
      harness.key({ key: "a" });
      const label = document.querySelector<HTMLElement>(".aaronnote-copilot-jump-target")
        ?.dataset.copilotJumpLabel;
      expect(label).toBeTruthy();
      harness.key({ key: label! });
      expect(harness.editor.insertions).toEqual(["Sta"]);

      const nextKey = harness.key({ key: label! });
      expect(nextKey.defaultPrevented).toBe(false);
      const nextInput = harness.beforeInput(label!);
      expect(nextInput.defaultPrevented).toBe(false);
    } finally {
      harness.dispose();
    }
  });

  test("Cmd+} keeps snippet and structural navigation when no ghost is visible", () => {
    let snippetJumps = 0;
    let delimiterJumps = 0;
    const snippet = createCopilotHarness({
      jumpSnippetNext: () => {
        snippetJumps += 1;
        return true;
      },
      forwardDelimiter: () => {
        delimiterJumps += 1;
        return true;
      },
    });
    try {
      const event = snippet.key({ key: "]", code: "BracketRight", metaKey: true, shiftKey: true });
      expect(event.defaultPrevented).toBe(true);
      expect(snippetJumps).toBe(1);
      expect(delimiterJumps).toBe(0);
    } finally {
      snippet.dispose();
    }

    const delimiter = createCopilotHarness({
      jumpSnippetNext: () => false,
      forwardDelimiter: () => {
        delimiterJumps += 1;
        return true;
      },
    });
    try {
      delimiter.key({ key: "}", code: "BracketRight", metaKey: true, shiftKey: true });
      expect(delimiterJumps).toBe(1);
    } finally {
      delimiter.dispose();
    }
  });

  test("jump and word acceptance never split grapheme clusters", async () => {
    const family = "👨‍👩‍👧‍👦";
    const suggestion = `A${family}B`;
    const jump = await visibleHarness({
      response: async (action) => action === "inline"
        ? {
            items: [{
              insertText: `prefix${suggestion}`,
              range: { from: 0, to: "prefix".length },
              item: { insertText: `prefix${suggestion}` },
            }],
          }
        : { ok: true },
    });
    try {
      jump.key({ key: "]", code: "BracketRight", metaKey: true, shiftKey: true });
      expect(document.querySelector(".aaronnote-copilot-jump-target")).toBeFalsy();
      jump.key({ key: family });
      const familyTarget = [...document.querySelectorAll<HTMLElement>(".aaronnote-copilot-jump-target")]
        .find((candidate) => candidate.textContent === family);
      expect(familyTarget).toBeTruthy();
      for (const key of familyTarget!.dataset.copilotJumpLabel!) jump.key({ key });
      expect(jump.editor.insertions).toEqual([`A${family}`]);
    } finally {
      jump.dispose();
    }

    const word = await visibleHarness({
      response: async (action) => action === "inline"
        ? {
            items: [{
              insertText: `prefix${family}tail`,
              range: { from: 0, to: "prefix".length },
              item: { insertText: `prefix${family}tail` },
            }],
          }
        : { ok: true },
    });
    try {
      word.key({ key: "\\", metaKey: true });
      expect(word.editor.insertions).toEqual([family]);
      expect(word.ghost()?.textContent).toBe("tail");
    } finally {
      word.dispose();
    }
  });

  test("renders multiline ghost rows and S-jump labels matching targets on visible lines", async () => {
    const harness = await visibleHarness({
      response: async (action) => action === "inline"
        ? {
            items: [{
              insertText: "prefixone\ntwo\nthree",
              range: { from: 0, to: "prefix".length },
              item: { insertText: "prefixone\ntwo\nthree" },
            }],
          }
        : { ok: true },
    });
    try {
      expect(document.querySelectorAll(".aaronnote-copilot-ghost-line")).toHaveLength(3);
      expect([...document.querySelectorAll(".aaronnote-copilot-ghost-line")].map((line) => line.textContent))
        .toEqual(["one", "two", "three"]);

      harness.key({ key: "]", code: "BracketRight", metaKey: true, shiftKey: true });
      expect(document.querySelector(".aaronnote-copilot-jump-target")).toBeFalsy();
      harness.key({ key: "t" });
      const targets = [...document.querySelectorAll<HTMLElement>(".aaronnote-copilot-jump-target")];
      expect(targets.map((target) => target.textContent)).toEqual(["t", "t"]);
      for (const key of targets[0]!.dataset.copilotJumpLabel!) harness.key({ key });
      expect(harness.editor.insertions).toEqual(["one\nt"]);
      expect([...document.querySelectorAll(".aaronnote-copilot-ghost-line")].map((line) => line.textContent))
        .toEqual(["wo", "three"]);

      harness.key({ key: "]", metaKey: true });
      expect(harness.editor.markdown).toBe("prefixone\ntwo\nthree");
      expect(harness.ghost()?.hidden).toBe(true);
    } finally {
      harness.dispose();
    }
  });

  test("word acceptance includes leading spacing and reports cumulative partial length", async () => {
    const harness = await visibleHarness({
      response: async (action) => action === "inline"
        ? {
            items: [{
              insertText: "prefixAlpha Beta",
              range: { from: 0, to: "prefix".length },
              item: { insertText: "prefixAlpha Beta" },
            }],
          }
        : { ok: true },
    });
    try {
      harness.key({ key: "\\", metaKey: true });
      expect(harness.editor.insertions).toEqual(["Alpha"]);
      expect(harness.ghost()?.textContent).toBe(" Beta");
      const partial = harness.requests.find((request) => request.action === "accept");
      expect(partial?.body.acceptedLength).toBe("prefixAlpha".length);

      harness.key({ key: "\\", metaKey: true });
      expect(harness.editor.insertions).toEqual(["Alpha", " Beta"]);
      expect(harness.editor.markdown).toBe("prefixAlpha Beta");
      expect(harness.ghost()?.hidden).toBe(true);
    } finally {
      harness.dispose();
    }
  });

  test("a debounced empty refresh retires a ghost after matching typed text", async () => {
    let inlineRequests = 0;
    const harness = await visibleHarness({
      idleDelayMs: 1,
      response: async (action, body) => {
        if (action !== "inline") return { ok: true };
        inlineRequests += 1;
        if (String(body.content || "").endsWith("Sta")) return { items: [] };
        return {
          items: [{
            insertText: "prefixStable",
            range: { from: 0, to: "prefix".length },
            item: { insertText: "prefixStable" },
          }],
        };
      },
    });
    try {
      harness.type("Sta");
      expect(harness.ghost()?.textContent).toBe("ble");
      await new Promise((resolve) => window.setTimeout(resolve, 10));
      await waitForMicrotasks();
      expect(inlineRequests).toBeGreaterThanOrEqual(2);
      expect(harness.ghost()?.hidden).toBe(true);
    } finally {
      harness.dispose();
    }
  });

  test("bounds ghost DOM and S-jump scanning for pathological long suggestions", async () => {
    const suffix = "x".repeat(3_000);
    const harness = await visibleHarness({
      response: async (action) => action === "inline"
        ? {
            items: [{
              insertText: `prefix${suffix}`,
              range: { from: 0, to: "prefix".length },
              item: { insertText: `prefix${suffix}` },
            }],
          }
        : { ok: true },
    });
    try {
      expect(harness.ghost()?.dataset.truncated).toBe("true");
      expect(harness.ghost()?.textContent?.length).toBe(2_048);

      harness.key({ key: "]", code: "BracketRight", metaKey: true, shiftKey: true });
      expect(document.querySelector(".aaronnote-copilot-jump-target")).toBeFalsy();
      harness.key({ key: "x" });
      expect(document.querySelectorAll(".aaronnote-copilot-jump-target")).toHaveLength(2_048);
    } finally {
      harness.dispose();
    }
  });

  test("rejects completion ranges that replace text after the cursor", async () => {
    const harness = createCopilotHarness({
      response: async (action) => action === "inline"
        ? {
            items: [{
              insertText: "prefixReplacement",
              range: { from: 0, to: "prefix".length + 1 },
              item: { insertText: "prefixReplacement" },
            }],
          }
        : { ok: true },
    });
    try {
      await harness.trigger();
      expect(harness.ghost()?.hidden).toBe(true);
      expect(harness.editor.insertions).toEqual([]);
    } finally {
      harness.dispose();
    }
  });

});
