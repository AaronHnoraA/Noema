import { describe, expect, test, vi } from "@voidzero-dev/vite-plus-test";

import { createEditor } from "../src/lib.ts";
import { createVimLite } from "../aaronnote/vim-lite.ts";
import {
  guardXwidgetControlBeforeInput,
  handleXwidgetEmacsKeydown,
  handleXwidgetControlBeforeInput,
  guardXwidgetControlKeydown,
  handleXwidgetControlKeydown,
  handleXwidgetHistoryKeydown,
  handleXwidgetMathBeforeInput,
  handleXwidgetMathKeydown,
  handleXwidgetSpecialBeforeInput,
  handleXwidgetSpecialKeydown,
  handleXwidgetVimBeforeInput,
  handleXwidgetVimKeydown,
} from "../aaronnote/xwidget-key-guard.ts";

function runGuard(
  target: HTMLElement,
  key: string,
  host: HTMLElement,
  init: KeyboardEventInit = {},
): { guarded: boolean; defaultPrevented: boolean } {
  let guarded = false;
  const listener = (event: KeyboardEvent): void => {
    guarded = guardXwidgetControlKeydown(event, host);
  };
  document.addEventListener("keydown", listener, true);
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  document.removeEventListener("keydown", listener, true);
  return { guarded, defaultPrevented: event.defaultPrevented };
}

function withMounted<T extends HTMLElement>(element: T): T {
  document.body.appendChild(element);
  return element;
}

type ForwardedEmacsKey = string | { key: string; client?: string };

function withForwardedEmacsKeys(run: (forwarded: string[]) => void): void {
  const forwarded: string[] = [];
  const win = window as Window & {
    aaronnoteApi?: { emacs?: { key?: (key: ForwardedEmacsKey) => unknown } };
  };
  const previousApi = win.aaronnoteApi;
  try {
    win.aaronnoteApi = {
      emacs: {
        key: async (key: ForwardedEmacsKey) => {
          forwarded.push(typeof key === "string" ? key : key.key);
        },
      },
    };
    run(forwarded);
  } finally {
    win.aaronnoteApi = previousApi;
  }
}

function withForwardedEmacsPayloads(run: (forwarded: ForwardedEmacsKey[]) => void): void {
  const forwarded: ForwardedEmacsKey[] = [];
  const win = window as Window & {
    aaronnoteApi?: { emacs?: { key?: (key: ForwardedEmacsKey) => unknown } };
  };
  const previousApi = win.aaronnoteApi;
  try {
    win.aaronnoteApi = {
      emacs: {
        key: async (key: ForwardedEmacsKey) => {
          forwarded.push(key);
        },
      },
    };
    run(forwarded);
  } finally {
    win.aaronnoteApi = previousApi;
  }
}

function withNavigatorPlatform(platform: string, run: () => void): void {
  const original = Object.getOwnPropertyDescriptor(navigator, "platform");
  Object.defineProperty(navigator, "platform", { configurable: true, value: platform });
  try {
    run();
  } finally {
    if (original) {
      Object.defineProperty(navigator, "platform", original);
    } else {
      delete (navigator as unknown as { platform?: string }).platform;
    }
  }
}

describe("xwidget key guard", () => {
  test("guards known control keys outside editor and text controls", () => {
    const host = withMounted(document.createElement("section"));
    const button = withMounted(document.createElement("button"));
    try {
      for (const key of ["Escape", "Delete", "Backspace"]) {
        const result = runGuard(button, key, host);
        expect(result.guarded).toBe(true);
        expect(result.defaultPrevented).toBe(true);
      }
    } finally {
      button.remove();
      host.remove();
    }
  });

  test("does not guard ordinary text keys or modified control keys", () => {
    const host = withMounted(document.createElement("section"));
    const button = withMounted(document.createElement("button"));
    try {
      expect(runGuard(button, "a", host)).toEqual({ guarded: false, defaultPrevented: false });
      expect(runGuard(button, "Delete", host, { metaKey: true })).toEqual({ guarded: false, defaultPrevented: false });
      expect(runGuard(button, "Escape", host, { ctrlKey: true })).toEqual({ guarded: false, defaultPrevented: false });
    } finally {
      button.remove();
      host.remove();
    }
  });

  test("leaves text editing targets alone", () => {
    const host = withMounted(document.createElement("section"));
    const input = withMounted(document.createElement("input"));
    const textarea = withMounted(document.createElement("textarea"));
    const editable = withMounted(document.createElement("div"));
    const nativeWidget = withMounted(document.createElement("div"));
    editable.contentEditable = "true";
    nativeWidget.dataset.aaronnoteVim = "native";
    try {
      for (const target of [input, textarea, editable, nativeWidget]) {
        expect(runGuard(target, "Delete", host)).toEqual({ guarded: false, defaultPrevented: false });
        expect(runGuard(target, "Backspace", host)).toEqual({ guarded: false, defaultPrevented: false });
      }
    } finally {
      input.remove();
      textarea.remove();
      editable.remove();
      nativeWidget.remove();
      host.remove();
    }
  });

  test("routes xwidget Delete and its control-byte beforeinput through LiveTeX once", () => {
    const host = withMounted(document.createElement("section"));
    const editor = createEditor(host, { initialContent: "\\[x\\]" });
    const vim = createVimLite(editor, host);
    const visual = document.createElement("div");
    visual.dataset.cmVisualMath = "active";
    visual.dataset.aaronnoteVim = "native";
    const target = document.createElement("span");
    visual.append(target);
    host.append(visual);
    const routed: string[] = [];
    const listener = (event: Event): void => {
      const custom = event as CustomEvent<{ key?: string }>;
      routed.push(String(custom.detail?.key || ""));
      custom.preventDefault();
    };
    document.addEventListener("aaronnote:math-host-key", listener);
    try {
      const keydown = new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true });
      Object.defineProperty(keydown, "target", { value: target });
      expect(handleXwidgetMathKeydown(keydown, { editor, editorHost: host, vim })).toBe(true);
      expect(keydown.defaultPrevented).toBe(true);

      const beforeinput = new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        data: "\u007f",
        inputType: "insertText",
      });
      Object.defineProperty(beforeinput, "target", { value: target });
      expect(handleXwidgetMathBeforeInput(beforeinput, { editor, editorHost: host, vim })).toBe(true);
      expect(beforeinput.defaultPrevented).toBe(true);
      expect(routed).toEqual(["Delete"]);
    } finally {
      document.removeEventListener("aaronnote:math-host-key", listener);
      editor.destroy();
      host.remove();
    }
  });

  test("routes legacy and beforeinput-only Space/Backslash through LiveTeX", () => {
    const host = withMounted(document.createElement("section"));
    const editor = createEditor(host, { initialContent: "\\[x\\]" });
    const vim = createVimLite(editor, host);
    const visual = document.createElement("div");
    visual.dataset.cmVisualMath = "active";
    const target = document.createElement("span");
    visual.append(target);
    host.append(visual);
    const routed: Array<{ key: string; text: string }> = [];
    const listener = (event: Event): void => {
      const custom = event as CustomEvent<{ key?: string; text?: string }>;
      routed.push({ key: String(custom.detail?.key ?? ""), text: String(custom.detail?.text ?? "") });
      custom.preventDefault();
    };
    document.addEventListener("aaronnote:math-host-key", listener);
    try {
      const legacyKeydown = new KeyboardEvent("keydown", {
        key: "Spacebar",
        code: "Space",
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(legacyKeydown, "target", { value: target });
      expect(handleXwidgetMathKeydown(legacyKeydown, { editor, editorHost: host, vim })).toBe(true);

      const pairedInput = new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        data: " ",
        inputType: "insertText",
      });
      Object.defineProperty(pairedInput, "target", { value: target });
      expect(handleXwidgetMathBeforeInput(pairedInput, { editor, editorHost: host, vim })).toBe(true);
      expect(routed).toEqual([{ key: " ", text: "" }]);

      const inputOnly = new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        data: " ",
        inputType: "insertText",
      });
      Object.defineProperty(inputOnly, "target", { value: target });
      expect(handleXwidgetMathBeforeInput(inputOnly, { editor, editorHost: host, vim })).toBe(true);
      expect(inputOnly.defaultPrevented).toBe(true);
      expect(routed).toEqual([
        { key: " ", text: "" },
        { key: " ", text: " " },
      ]);

      const legacyReturn = new KeyboardEvent("keydown", {
        key: "CR",
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(legacyReturn, "target", { value: target });
      expect(handleXwidgetMathKeydown(legacyReturn, { editor, editorHost: host, vim })).toBe(true);
      expect(routed.at(-1)).toEqual({ key: "Enter", text: "" });

      const backslashKeydown = new KeyboardEvent("keydown", {
        key: "Backslash",
        code: "Backslash",
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(backslashKeydown, "target", { value: target });
      expect(handleXwidgetMathKeydown(backslashKeydown, { editor, editorHost: host, vim })).toBe(true);
      expect(routed.at(-1)).toEqual({ key: "\\", text: "" });

      const pairedBackslash = new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        data: "\\",
        inputType: "insertText",
      });
      Object.defineProperty(pairedBackslash, "target", { value: target });
      expect(handleXwidgetMathBeforeInput(pairedBackslash, { editor, editorHost: host, vim })).toBe(true);

      const inputOnlyBackslash = new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        data: "\\",
        inputType: "insertText",
      });
      Object.defineProperty(inputOnlyBackslash, "target", { value: target });
      expect(handleXwidgetMathBeforeInput(inputOnlyBackslash, { editor, editorHost: host, vim })).toBe(true);
      expect(routed.at(-1)).toEqual({ key: "\\", text: "\\" });
    } finally {
      document.removeEventListener("aaronnote:math-host-key", listener);
      editor.destroy();
      host.remove();
    }
  });

  test("drops printable beforeinput paired with LiveTeX boundary modifier chords", () => {
    const host = withMounted(document.createElement("section"));
    const editor = createEditor(host, { initialContent: "\\[x\\]" });
    const vim = createVimLite(editor, host);
    const routed: Array<{ key: string; code: string }> = [];
    const listener = (event: Event): void => {
      const custom = event as CustomEvent<{ key?: string; code?: string }>;
      routed.push({
        key: String(custom.detail?.key || ""),
        code: String(custom.detail?.code || ""),
      });
      // Cmd-] is consumed by LiveTeX itself; Cmd-/ deliberately falls through
      // to Noema's document-level Source/WYSIWYG boundary.
      if (custom.detail?.key !== "/") custom.preventDefault();
    };
    document.addEventListener("aaronnote:math-host-key", listener);
    try {
      for (const chord of [
        { key: "]", code: "BracketRight", leakedText: "\\" },
        { key: "/", code: "Slash", leakedText: "/" },
      ]) {
        const visual = document.createElement("div");
        visual.dataset.cmVisualMath = "active";
        const target = document.createElement("span");
        visual.append(target);
        host.append(visual);

        const keydown = new KeyboardEvent("keydown", {
          key: chord.key,
          code: chord.code,
          metaKey: true,
          bubbles: true,
          cancelable: true,
        });
        Object.defineProperty(keydown, "target", { value: target });
        expect(handleXwidgetMathKeydown(keydown, { editor, editorHost: host, vim }))
          .toBe(chord.key !== "/");
        visual.remove();

        const beforeinput = new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          data: chord.leakedText,
          inputType: "insertText",
        });
        Object.defineProperty(beforeinput, "target", { value: host });
        expect(handleXwidgetMathBeforeInput(beforeinput, { editor, editorHost: host, vim })).toBe(true);
        expect(beforeinput.defaultPrevented).toBe(true);
      }
      expect(routed).toEqual([
        { key: "]", code: "BracketRight" },
        { key: "/", code: "Slash" },
      ]);
    } finally {
      document.removeEventListener("aaronnote:math-host-key", listener);
      editor.destroy();
      host.remove();
    }
  });

  test("does not drop unrelated text after a LiveTeX modifier chord", () => {
    const host = withMounted(document.createElement("section"));
    const editor = createEditor(host, { initialContent: "\\[x\\]" });
    const vim = createVimLite(editor, host);
    const visual = document.createElement("div");
    visual.dataset.cmVisualMath = "active";
    const target = document.createElement("span");
    visual.append(target);
    host.append(visual);
    const listener = (event: Event): void => {
      const custom = event as CustomEvent<{ key?: string }>;
      if (custom.detail?.key === "]") custom.preventDefault();
    };
    document.addEventListener("aaronnote:math-host-key", listener);
    try {
      const keydown = new KeyboardEvent("keydown", {
        key: "]",
        code: "BracketRight",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(keydown, "target", { value: target });
      expect(handleXwidgetMathKeydown(keydown, { editor, editorHost: host, vim })).toBe(true);
      visual.remove();

      const unrelated = new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        data: "a",
        inputType: "insertText",
      });
      Object.defineProperty(unrelated, "target", { value: host });
      expect(handleXwidgetMathBeforeInput(unrelated, { editor, editorHost: host, vim })).toBe(false);
      expect(unrelated.defaultPrevented).toBe(false);
    } finally {
      document.removeEventListener("aaronnote:math-host-key", listener);
      editor.destroy();
      host.remove();
    }
  });

  test("does not mistake beforeinput-only Space after an Arrow key for a duplicate", () => {
    const host = withMounted(document.createElement("section"));
    const editor = createEditor(host, { initialContent: "\\[xy\\]" });
    const vim = createVimLite(editor, host);
    const visual = document.createElement("div");
    visual.dataset.cmVisualMath = "active";
    const target = document.createElement("span");
    visual.append(target);
    host.append(visual);
    const routed: string[] = [];
    const listener = (event: Event): void => {
      const custom = event as CustomEvent<{ key?: string }>;
      routed.push(String(custom.detail?.key || ""));
      custom.preventDefault();
    };
    document.addEventListener("aaronnote:math-host-key", listener);
    try {
      const arrow = new KeyboardEvent("keydown", {
        key: "ArrowRight",
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(arrow, "target", { value: target });
      expect(handleXwidgetMathKeydown(arrow, { editor, editorHost: host, vim })).toBe(true);

      const space = new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        data: " ",
        inputType: "insertText",
      });
      Object.defineProperty(space, "target", { value: target });
      expect(handleXwidgetMathBeforeInput(space, { editor, editorHost: host, vim })).toBe(true);
      expect(routed).toEqual(["ArrowRight", " "]);
    } finally {
      document.removeEventListener("aaronnote:math-host-key", listener);
      editor.destroy();
      host.remove();
    }
  });

  test("leaves clipboard beforeinput native after an unhandled Cmd-V", () => {
    const host = withMounted(document.createElement("section"));
    const editor = createEditor(host, { initialContent: "\\[x\\]" });
    const vim = createVimLite(editor, host);
    const visual = document.createElement("div");
    visual.dataset.cmVisualMath = "active";
    const target = document.createElement("span");
    visual.append(target);
    host.append(visual);
    const listener = (event: Event): void => {
      const custom = event as CustomEvent<{ key?: string }>;
      if (custom.detail?.key !== "v") custom.preventDefault();
    };
    document.addEventListener("aaronnote:math-host-key", listener);
    try {
      const pasteKey = new KeyboardEvent("keydown", {
        key: "v",
        code: "KeyV",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(pasteKey, "target", { value: target });
      expect(handleXwidgetMathKeydown(pasteKey, { editor, editorHost: host, vim })).toBe(false);

      const paste = new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        data: "pasted",
        inputType: "insertFromPaste",
      });
      Object.defineProperty(paste, "target", { value: target });
      expect(handleXwidgetMathBeforeInput(paste, { editor, editorHost: host, vim })).toBe(false);
      expect(paste.defaultPrevented).toBe(false);
    } finally {
      document.removeEventListener("aaronnote:math-host-key", listener);
      editor.destroy();
      host.remove();
    }
  });

  test("deduplicates modified MathLive deletion beforeinput by direction", () => {
    const host = withMounted(document.createElement("section"));
    const editor = createEditor(host, { initialContent: "\\[alpha\\]" });
    const vim = createVimLite(editor, host);
    const visual = document.createElement("div");
    visual.dataset.cmVisualMath = "active";
    const target = document.createElement("span");
    visual.append(target);
    host.append(visual);
    const routed: string[] = [];
    const listener = (event: Event): void => {
      const custom = event as CustomEvent<{ key?: string }>;
      routed.push(String(custom.detail?.key || ""));
      custom.preventDefault();
    };
    document.addEventListener("aaronnote:math-host-key", listener);
    try {
      const keydown = new KeyboardEvent("keydown", {
        key: "Backspace",
        altKey: true,
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(keydown, "target", { value: target });
      expect(handleXwidgetMathKeydown(keydown, { editor, editorHost: host, vim })).toBe(true);

      const beforeinput = new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "deleteWordBackward",
      });
      Object.defineProperty(beforeinput, "target", { value: target });
      expect(handleXwidgetMathBeforeInput(beforeinput, { editor, editorHost: host, vim })).toBe(true);
      expect(beforeinput.defaultPrevented).toBe(true);
      expect(routed).toEqual(["Backspace"]);
    } finally {
      document.removeEventListener("aaronnote:math-host-key", listener);
      editor.destroy();
      host.remove();
    }
  });

  test("maps a control-byte-only LiveTeX beforeinput to Delete", () => {
    const host = withMounted(document.createElement("section"));
    const editor = createEditor(host, { initialContent: "\\[x\\]" });
    const vim = createVimLite(editor, host);
    const visual = document.createElement("div");
    visual.dataset.cmVisualMath = "active";
    const target = document.createElement("span");
    visual.append(target);
    host.append(visual);
    let routed = "";
    const listener = (event: Event): void => {
      const custom = event as CustomEvent<{ key?: string }>;
      routed = String(custom.detail?.key || "");
      custom.preventDefault();
    };
    document.addEventListener("aaronnote:math-host-key", listener);
    try {
      const event = new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        data: "\u007f",
        inputType: "insertText",
      });
      Object.defineProperty(event, "target", { value: target });
      expect(handleXwidgetMathBeforeInput(event, { editor, editorHost: host, vim })).toBe(true);
      expect(routed).toBe("Delete");
    } finally {
      document.removeEventListener("aaronnote:math-host-key", listener);
      editor.destroy();
      host.remove();
    }
  });

  test("guards editor-host control keys before CodeMirror sees them", () => {
    const host = withMounted(document.createElement("section"));
    const editorContent = document.createElement("div");
    host.appendChild(editorContent);
    try {
      expect(runGuard(editorContent, "Delete", host)).toEqual({ guarded: true, defaultPrevented: true });
      expect(runGuard(editorContent, "Escape", host)).toEqual({ guarded: true, defaultPrevented: true });
    } finally {
      host.remove();
    }
  });

  test("handles Delete and Backspace through the editor API even when focus is not in CM6", () => {
    const host = withMounted(document.createElement("section"));
    const editor = createEditor(host, { initialContent: "abc" });
    const vim = createVimLite(editor, host);
    const target = document.body;
    editor.setMarkdownSelection(1);
    try {
      const del = new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true });
      Object.defineProperty(del, "target", { value: target });
      expect(handleXwidgetControlKeydown(del, { editor, editorHost: host, vim })).toBe(true);
      expect(del.defaultPrevented).toBe(true);
      expect(editor.getMarkdown()).toBe("ac");

      const backspace = new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true });
      Object.defineProperty(backspace, "target", { value: target });
      expect(handleXwidgetControlKeydown(backspace, { editor, editorHost: host, vim })).toBe(true);
      expect(backspace.defaultPrevented).toBe(true);
      expect(editor.getMarkdown()).toBe("c");
    } finally {
      editor.destroy();
      host.remove();
    }
  });

  test("xwidget Delete and Backspace remove whole grapheme clusters", () => {
    const host = withMounted(document.createElement("section"));
    const editor = createEditor(host, { initialContent: "A👍🏽B" });
    const vim = createVimLite(editor, host);
    try {
      editor.setMarkdownSelection(5);
      const backspace = new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true });
      Object.defineProperty(backspace, "target", { value: document.body });
      expect(handleXwidgetControlKeydown(backspace, { editor, editorHost: host, vim })).toBe(true);
      expect(editor.getMarkdown()).toBe("AB");

      editor.setMarkdown("A👍🏽B", { history: "reset" });
      editor.setMarkdownSelection(1);
      const del = new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true });
      Object.defineProperty(del, "target", { value: document.body });
      expect(handleXwidgetControlKeydown(del, { editor, editorHost: host, vim })).toBe(true);
      expect(editor.getMarkdown()).toBe("AB");
    } finally {
      editor.destroy();
      host.remove();
    }
  });

  test("maps raw xwidget keydown control bytes before they can insert glyphs", () => {
    const host = withMounted(document.createElement("section"));
    const editor = createEditor(host, { initialContent: "abc" });
    const vim = createVimLite(editor, host);
    const target = document.body;
    editor.setMarkdownSelection(1);
    try {
      const del = new KeyboardEvent("keydown", { key: "\u007f", bubbles: true, cancelable: true });
      Object.defineProperty(del, "target", { value: target });
      expect(handleXwidgetControlKeydown(del, { editor, editorHost: host, vim })).toBe(true);
      expect(del.defaultPrevented).toBe(true);
      expect(editor.getMarkdown()).toBe("ac");

      const backspace = new KeyboardEvent("keydown", { key: "\u0008", bubbles: true, cancelable: true });
      Object.defineProperty(backspace, "target", { value: target });
      expect(handleXwidgetControlKeydown(backspace, { editor, editorHost: host, vim })).toBe(true);
      expect(backspace.defaultPrevented).toBe(true);
      expect(editor.getMarkdown()).toBe("c");
    } finally {
      editor.destroy();
      host.remove();
    }
  });

  test("maps xwidget beforeinput control bytes into editor actions", () => {
    const host = withMounted(document.createElement("section"));
    const editor = createEditor(host, { initialContent: "abc" });
    const vim = createVimLite(editor, host);
    editor.setMarkdownSelection(1);
    try {
      const delText = new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        data: "\u007f",
        inputType: "insertText",
      });
      Object.defineProperty(delText, "target", { value: document.body });
      expect(handleXwidgetControlBeforeInput(delText, { editor, editorHost: host, vim })).toBe(true);
      expect(delText.defaultPrevented).toBe(true);
      expect(editor.getMarkdown()).toBe("ac");

      vim.setMode("insert");
      const escText = new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        data: "\u001b",
        inputType: "insertText",
      });
      Object.defineProperty(escText, "target", { value: document.body });
      expect(handleXwidgetControlBeforeInput(escText, { editor, editorHost: host, vim })).toBe(true);
      expect(escText.defaultPrevented).toBe(true);
      expect(vim.mode()).toBe("normal");
    } finally {
      editor.destroy();
      host.remove();
    }
  });

  test("maps delete beforeinput inputTypes into editor actions", () => {
    const host = withMounted(document.createElement("section"));
    const editor = createEditor(host, { initialContent: "abc" });
    const vim = createVimLite(editor, host);
    editor.setMarkdownSelection(2);
    try {
      const backspace = new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        data: null,
        inputType: "deleteContentBackward",
      });
      Object.defineProperty(backspace, "target", { value: document.body });
      expect(handleXwidgetControlBeforeInput(backspace, { editor, editorHost: host, vim })).toBe(true);
      expect(editor.getMarkdown()).toBe("ac");
    } finally {
      editor.destroy();
      host.remove();
    }
  });

  test("handles insert-mode Enter through CM6 commands when focus is not in CM6", () => {
    const host = withMounted(document.createElement("section"));
    const editor = createEditor(host, { initialContent: "abc" });
    const vim = createVimLite(editor, host);
    vim.setMode("insert");
    editor.setMarkdownSelection(1);
    try {
      const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
      Object.defineProperty(event, "target", { value: document.body });
      expect(handleXwidgetSpecialKeydown(event, { editor, editorHost: host, vim })).toBe(true);
      expect(event.defaultPrevented).toBe(true);
      expect(editor.getMarkdown()).toBe("a\nbc");
    } finally {
      editor.destroy();
      host.remove();
    }
  });

  test("handles insert-mode Tab and Shift-Tab through CM6 list indentation", () => {
    const host = withMounted(document.createElement("section"));
    const editor = createEditor(host, { initialContent: "- parent\n- item" });
    const vim = createVimLite(editor, host);
    vim.setMode("insert");
    editor.setMarkdownSelection(editor.getMarkdown().indexOf("item"));
    try {
      const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
      Object.defineProperty(tab, "target", { value: document.body });
      expect(handleXwidgetSpecialKeydown(tab, { editor, editorHost: host, vim })).toBe(true);
      expect(tab.defaultPrevented).toBe(true);
      expect(editor.getMarkdown()).toBe("- parent\n    - item");

      const shiftTab = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
      Object.defineProperty(shiftTab, "target", { value: document.body });
      expect(handleXwidgetSpecialKeydown(shiftTab, { editor, editorHost: host, vim })).toBe(true);
      expect(editor.getMarkdown()).toBe("- parent\n- item");
    } finally {
      editor.destroy();
      host.remove();
    }
  });

  test("insert arrows stay native while normal j uses Vim screen-line motion", () => {
    const host = withMounted(document.createElement("section"));
    const editor = createEditor(host, { initialContent: "aa\nbbbb\ncc" });
    const vim = createVimLite(editor, host);
    vim.setMode("insert");
    editor.setMarkdownSelection(1);
    try {
      const down = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
      Object.defineProperty(down, "target", { value: document.body });
      expect(handleXwidgetSpecialKeydown(down, { editor, editorHost: host, vim })).toBe(true);

      editor.setMarkdownSelection(1);
      vim.setMode("normal");
      expect(vim.handleKey({ key: "j" })).toBe(true);
      expect(editor.getMarkdownSelection().from).toBe(4);
    } finally {
      editor.destroy();
      host.remove();
    }
  });

  test("keeps insert-mode Shift-Tab from escaping focus on plain text", () => {
    const host = withMounted(document.createElement("section"));
    const editor = createEditor(host, { initialContent: "plain" });
    const vim = createVimLite(editor, host);
    vim.setMode("insert");
    editor.setMarkdownSelection(5);
    try {
      const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
      Object.defineProperty(event, "target", { value: document.body });
      expect(handleXwidgetSpecialKeydown(event, { editor, editorHost: host, vim })).toBe(true);
      expect(event.defaultPrevented).toBe(true);
      expect(editor.getMarkdown()).toBe("plain");
    } finally {
      editor.destroy();
      host.remove();
    }
  });

  test("handles Backtab as insert-mode Shift-Tab", () => {
    const host = withMounted(document.createElement("section"));
    const editor = createEditor(host, { initialContent: "  - item" });
    const vim = createVimLite(editor, host);
    vim.setMode("insert");
    editor.setMarkdownSelection(4);
    try {
      const event = new KeyboardEvent("keydown", { key: "Backtab", bubbles: true, cancelable: true });
      Object.defineProperty(event, "target", { value: document.body });
      expect(handleXwidgetSpecialKeydown(event, { editor, editorHost: host, vim })).toBe(true);
      expect(event.defaultPrevented).toBe(true);
      expect(editor.getMarkdown()).toBe("- item");
    } finally {
      editor.destroy();
      host.remove();
    }
  });

  test("handles insert-mode arrow keys through CM6 cursor commands", () => {
    const host = withMounted(document.createElement("section"));
    const editor = createEditor(host, { initialContent: "abc" });
    const vim = createVimLite(editor, host);
    vim.setMode("insert");
    editor.setMarkdownSelection(2);
    try {
      const event = new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true });
      Object.defineProperty(event, "target", { value: document.body });
      expect(handleXwidgetSpecialKeydown(event, { editor, editorHost: host, vim })).toBe(true);
      expect(event.defaultPrevented).toBe(true);
      expect(editor.getMarkdownSelection().from).toBe(1);
    } finally {
      editor.destroy();
      host.remove();
    }
  });

  test("routes insert-mode ArrowLeft into the adjacent inline formula editor", () => {
    const host = withMounted(document.createElement("section"));
    const markdown = "before \\(x\\) after";
    const editor = createEditor(host, { initialContent: markdown });
    const vim = createVimLite(editor, host);
    vim.setMode("insert");
    editor.setMarkdownSelection(markdown.indexOf("\\(x\\)") + "\\(x\\)".length);
    try {
      expect(host.querySelector(".cm-math-inline")).toBeTruthy();
      const event = new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true });
      Object.defineProperty(event, "target", { value: document.body });
      expect(handleXwidgetSpecialKeydown(event, { editor, editorHost: host, vim })).toBe(true);
      expect(event.defaultPrevented).toBe(true);
      expect(host.querySelector(".cm-math-inline-editor")).toBeTruthy();
    } finally {
      editor.destroy();
      host.remove();
    }
  });

  test("handles macOS Cmd+Shift+Z redo when focus is outside CM6", () => {
    withNavigatorPlatform("MacIntel", () => {
      const host = withMounted(document.createElement("section"));
      const editor = createEditor(host, { initialContent: "abc" });
      const vim = createVimLite(editor, host);
      try {
        editor.setMarkdownSelection(3);
        editor.replaceMarkdownRange(3, 3, "d", "end");
        expect(editor.getMarkdown()).toBe("abcd");
        expect(editor.undo()).toBe(true);
        expect(editor.getMarkdown()).toBe("abc");
        const event = new KeyboardEvent("keydown", {
          key: "Z",
          code: "KeyZ",
          metaKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        });
        Object.defineProperty(event, "target", { value: document.body });
        expect(handleXwidgetHistoryKeydown(event, { editor, editorHost: host, vim })).toBe(true);
        expect(event.defaultPrevented).toBe(true);
        expect(editor.getMarkdown()).toBe("abcd");
      } finally {
        editor.destroy();
        host.remove();
      }
    });
  });

  test("maps insertParagraph beforeinput into CM6 Enter behavior", () => {
    const host = withMounted(document.createElement("section"));
    const editor = createEditor(host, { initialContent: "abc" });
    const vim = createVimLite(editor, host);
    vim.setMode("insert");
    editor.setMarkdownSelection(1);
    try {
      const event = new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        data: null,
        inputType: "insertParagraph",
      });
      Object.defineProperty(event, "target", { value: document.body });
      expect(handleXwidgetSpecialBeforeInput(event, { editor, editorHost: host, vim })).toBe(true);
      expect(event.defaultPrevented).toBe(true);
      expect(editor.getMarkdown()).toBe("a\nbc");
    } finally {
      editor.destroy();
      host.remove();
    }
  });

  test("maps raw newline beforeinput into markdown continuation", () => {
    const host = withMounted(document.createElement("section"));
    const editor = createEditor(host, { initialContent: "> - item" });
    const vim = createVimLite(editor, host);
    vim.setMode("insert");
    editor.setMarkdownSelection(editor.getMarkdown().length);
    try {
      const event = new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        data: "\n",
        inputType: "insertText",
      });
      Object.defineProperty(event, "target", { value: document.body });
      expect(handleXwidgetSpecialBeforeInput(event, { editor, editorHost: host, vim })).toBe(true);
      expect(event.defaultPrevented).toBe(true);
      expect(editor.getMarkdown()).toBe("> - item\n> - ");
    } finally {
      editor.destroy();
      host.remove();
    }
  });

  test("handles Escape as a first-layer Vim mode switch", () => {
    const host = withMounted(document.createElement("section"));
    const editor = createEditor(host, { initialContent: "abc" });
    const vim = createVimLite(editor, host);
    const target = editor.view.contentDOM;
    vim.setMode("insert");
    try {
      const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      Object.defineProperty(event, "target", { value: target });
      expect(handleXwidgetControlKeydown(event, { editor, editorHost: host, vim })).toBe(true);
      expect(event.defaultPrevented).toBe(true);
      expect(vim.mode()).toBe("normal");
    } finally {
      editor.destroy();
      host.remove();
    }
  });

  test("handles normal-mode Vim keydown even when focus is not in CM6", () => {
    const host = withMounted(document.createElement("section"));
    const editor = createEditor(host, { initialContent: "aa\nbbbb\ncc" });
    const vim = createVimLite(editor, host);
    vim.setMode("normal");
    editor.setMarkdownSelection(1);
    try {
      const down = new KeyboardEvent("keydown", { key: "j", bubbles: true, cancelable: true });
      Object.defineProperty(down, "target", { value: document.body });
      expect(handleXwidgetVimKeydown(down, { editor, editorHost: host, vim })).toBe(true);
      expect(down.defaultPrevented).toBe(true);
      expect(editor.getMarkdownSelection().from).toBe(4);

      const deleteChar = new KeyboardEvent("keydown", { key: "x", bubbles: true, cancelable: true });
      Object.defineProperty(deleteChar, "target", { value: document.body });
      expect(handleXwidgetVimKeydown(deleteChar, { editor, editorHost: host, vim })).toBe(true);
      expect(editor.getMarkdown()).toBe("aa\nbbb\ncc");
    } finally {
      editor.destroy();
      host.remove();
    }
  });

  test("leaves modified keys native inside embedded editable controls", () => {
    const host = withMounted(document.createElement("section"));
    const editor = createEditor(host, { initialContent: "abc" });
    const vim = createVimLite(editor, host);
    const editable = document.createElement("div");
    editable.contentEditable = "true";
    editable.textContent = "widget text";
    host.appendChild(editable);
    vim.setMode("normal");
    try {
      for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "a", "c", "v"]) {
        const event = new KeyboardEvent("keydown", {
          key,
          metaKey: true,
          bubbles: true,
          cancelable: true,
        });
        Object.defineProperty(event, "target", { value: editable });
        expect(vim.handleKeyDown(event)).toBe(false);
        expect(event.defaultPrevented).toBe(false);
      }
      expect(vim.mode()).toBe("normal");
    } finally {
      editor.destroy();
      host.remove();
    }
  });

  test("handles normal-mode s jump keydown even when focus is not in CM6", () => {
    const host = withMounted(document.createElement("section"));
    const editor = createEditor(host, { initialContent: "alpha beta gamma beta" });
    const vim = createVimLite(editor, host, { jumpTimeoutMs: 5 });
    vim.setMode("normal");
    editor.setMarkdownSelection(0);
    vi.useFakeTimers();
    try {
      const jump = new KeyboardEvent("keydown", { key: "s", bubbles: true, cancelable: true });
      Object.defineProperty(jump, "target", { value: document.body });
      expect(handleXwidgetVimKeydown(jump, { editor, editorHost: host, vim })).toBe(true);
      expect(document.querySelectorAll(".cm-vim-jump-label").length).toBe(0);

      const target = new KeyboardEvent("keydown", { key: "b", bubbles: true, cancelable: true });
      Object.defineProperty(target, "target", { value: document.body });
      expect(handleXwidgetVimKeydown(target, { editor, editorHost: host, vim })).toBe(true);
      expect(target.defaultPrevented).toBe(true);
      expect(document.querySelectorAll(".cm-vim-jump-label").length).toBe(0);
      expect(document.querySelectorAll(".cm-vim-jump-preview").length).toBe(2);
      vi.advanceTimersByTime(5);
      expect(document.querySelectorAll(".cm-vim-jump-label").length).toBe(2);

      const label = new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true });
      Object.defineProperty(label, "target", { value: document.body });
      expect(handleXwidgetVimKeydown(label, { editor, editorHost: host, vim })).toBe(true);
      expect(editor.getMarkdownSelection().from).toBe(6);
      expect(document.querySelectorAll(".cm-vim-jump-label").length).toBe(0);
    } finally {
      vi.useRealTimers();
      editor.destroy();
      host.remove();
    }
  });

  test("maps normal-mode beforeinput text into Vim commands instead of inserting", () => {
    const host = withMounted(document.createElement("section"));
    const editor = createEditor(host, { initialContent: "aa\nbbbb\ncc" });
    const vim = createVimLite(editor, host);
    vim.setMode("normal");
    editor.setMarkdownSelection(1);
    try {
      const input = new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        data: "j",
        inputType: "insertText",
      });
      Object.defineProperty(input, "target", { value: document.body });
      expect(handleXwidgetVimBeforeInput(input, { editor, editorHost: host, vim })).toBe(true);
      expect(input.defaultPrevented).toBe(true);
      expect(editor.getMarkdown()).toBe("aa\nbbbb\ncc");
      expect(editor.getMarkdownSelection().from).toBe(4);
    } finally {
      editor.destroy();
      host.remove();
    }
  });

  test("leaves insert-mode ordinary beforeinput alone", () => {
    const host = withMounted(document.createElement("section"));
    const editor = createEditor(host, { initialContent: "abc" });
    const vim = createVimLite(editor, host);
    vim.setMode("insert");
    try {
      const input = new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        data: "j",
        inputType: "insertText",
      });
      Object.defineProperty(input, "target", { value: document.body });
      expect(handleXwidgetVimBeforeInput(input, { editor, editorHost: host, vim })).toBe(false);
      expect(input.defaultPrevented).toBe(false);
    } finally {
      editor.destroy();
      host.remove();
    }
  });

  test("blocks xwidget control text before it is inserted", () => {
    const delText = new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      data: "\u007f",
      inputType: "insertText",
    });
    expect(guardXwidgetControlBeforeInput(delText)).toBe(true);
    expect(delText.defaultPrevented).toBe(true);

    const escText = new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      data: "\u001b",
      inputType: "insertText",
    });
    expect(guardXwidgetControlBeforeInput(escText)).toBe(true);
    expect(escText.defaultPrevented).toBe(true);

    const normalText = new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      data: "a",
      inputType: "insertText",
    });
    expect(guardXwidgetControlBeforeInput(normalText)).toBe(false);
    expect(normalText.defaultPrevented).toBe(false);
  });

  test("releases web input focus before forwarding a top-level Emacs key", () => {
    const input = withMounted(document.createElement("input"));
    try {
      withForwardedEmacsKeys((forwarded) => {
        input.focus();
        expect(document.activeElement).toBe(input);

        const event = new KeyboardEvent("keydown", {
          key: "ø",
          code: "KeyO",
          altKey: true,
          bubbles: true,
          cancelable: true,
        });
        Object.defineProperty(event, "target", { value: input });

        expect(handleXwidgetEmacsKeydown(event)).toBe(true);
        expect(event.defaultPrevented).toBe(true);
        expect(forwarded).toEqual(["H-o"]);
        expect(document.activeElement).not.toBe(input);
      });
    } finally {
      input.remove();
    }
  });

  test("forwards common bare Ctrl chords to Emacs", () => {
    withForwardedEmacsKeys((forwarded) => {
      const event = new KeyboardEvent("keydown", {
        key: "a",
        code: "KeyA",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      expect(handleXwidgetEmacsKeydown(event)).toBe(true);
      expect(event.defaultPrevented).toBe(true);
      expect(forwarded).toEqual(["C-a"]);
    });
  });

  test("normalizes shifted Ctrl prefix chords before forwarding to Emacs", () => {
    withForwardedEmacsKeys((forwarded) => {
      const prefix = new KeyboardEvent("keydown", {
        key: "X",
        code: "KeyX",
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
      expect(handleXwidgetEmacsKeydown(prefix)).toBe(true);
      expect(prefix.defaultPrevented).toBe(true);
      expect(forwarded).toEqual([]);

      const next = new KeyboardEvent("keydown", {
        key: "b",
        code: "KeyB",
        bubbles: true,
        cancelable: true,
      });
      expect(handleXwidgetEmacsKeydown(next)).toBe(true);
      expect(next.defaultPrevented).toBe(true);
      expect(forwarded).toEqual(["C-x b"]);
    });
  });

  test("normalizes shifted Ctrl second keys in Emacs prefix sequences", () => {
    withForwardedEmacsKeys((forwarded) => {
      const prefix = new KeyboardEvent("keydown", {
        key: "x",
        code: "KeyX",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      expect(handleXwidgetEmacsKeydown(prefix)).toBe(true);

      const next = new KeyboardEvent("keydown", {
        key: "B",
        code: "KeyB",
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
      expect(handleXwidgetEmacsKeydown(next)).toBe(true);
      expect(next.defaultPrevented).toBe(true);
      expect(forwarded).toEqual(["C-x C-b"]);
    });
  });

  test("forwards M-w so the app keeps Emacs kill-ring-save semantics", () => {
    withForwardedEmacsKeys((forwarded) => {
      const event = new KeyboardEvent("keydown", {
        key: "w",
        code: "KeyW",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      expect(handleXwidgetEmacsKeydown(event)).toBe(true);
      expect(event.defaultPrevented).toBe(true);
      expect(forwarded).toEqual(["M-w"]);
    });
  });

  test("leaves Cmd+Arrow keys to native CodeMirror/WebKit editing", () => {
    withForwardedEmacsKeys((forwarded) => {
      for (const shiftKey of [false, true]) {
        for (const arrowKey of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) {
          const event = new KeyboardEvent("keydown", {
            key: arrowKey,
            code: arrowKey,
            metaKey: true,
            shiftKey,
            bubbles: true,
            cancelable: true,
          });
          expect(handleXwidgetEmacsKeydown(event)).toBe(false);
          expect(event.defaultPrevented).toBe(false);
        }
      }

      expect(forwarded).toEqual([]);
    });
  });

  test("includes the Noema client when forwarding Emacs keys", () => {
    withForwardedEmacsPayloads((forwarded) => {
      const event = new KeyboardEvent("keydown", {
        key: "w",
        code: "KeyW",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      expect(handleXwidgetEmacsKeydown(event, { client: () => "split-client" })).toBe(true);
      expect(event.defaultPrevented).toBe(true);
      expect(forwarded).toEqual([{ key: "M-w", client: "split-client" }]);
    });
  });
});
