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

  test("cmd-shift-right-bracket enters accept-to-char mode on bracket-key layouts", async () => {
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
      target.dispatchEvent(new KeyboardEvent("keydown", {
        key: "B",
        bubbles: true,
        cancelable: true,
      }));

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
      expect(editor.cursorContextCalls - before).toBe(1);
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

});
