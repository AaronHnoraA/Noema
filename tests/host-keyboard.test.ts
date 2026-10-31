import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { installHostKeyboardBridge, pageClientFromLocation } from "../pages/host-keyboard.ts";
import { hostInputFocusReleased, reclaimHostInputFocus } from "../pages/host-input-focus.ts";

function trusted<T extends Event>(event: T): T {
  Object.defineProperty(event, "isTrusted", { value: true });
  return event;
}

function withBridge(client: string, run: (forwarded: unknown[]) => void): void {
  const win = window as Window & { noemaApi?: unknown };
  const previous = win.noemaApi;
  const forwarded: unknown[] = [];
  win.noemaApi = { emacs: { key: async (payload: unknown) => { forwarded.push(payload); } } };
  const uninstall = installHostKeyboardBridge({ client: () => client });
  try {
    run(forwarded);
  } finally {
    uninstall();
    win.noemaApi = previous;
    reclaimHostInputFocus();
  }
}

function hostCommand(command: string, targetClient?: string): void {
  window.dispatchEvent(new CustomEvent("noema:command", {
    detail: { command, ...(targetClient ? { targetClient } : {}) },
  }));
}

describe("shared Noema host keyboard bridge", () => {
  test("every page entry except the CM6 editor installs the bridge", () => {
    const directory = join(import.meta.dirname, "..", "pages");
    const entries = readdirSync(directory).filter((name) => name.endsWith(".html"))
      .map((name) => /src="\.\/([^"]+\.ts)"/.exec(readFileSync(join(directory, name), "utf8"))?.[1])
      .filter((entry): entry is string => Boolean(entry));
    expect(entries).toContain("main.ts");
    expect(entries.length).toBeGreaterThanOrEqual(6);
    for (const entry of entries) {
      const source = readFileSync(join(directory, entry), "utf8");
      if (entry === "main.ts") {
        // The editor composes the same primitives around CM6 and Vim, and
        // yields unfocused keys before registering any other key listener.
        expect(source).toContain("handleHostOwnedKey(event");
        expect(source).toContain("case \"host-owns-keyboard\":");
        const yieldAt = source.indexOf("installNativeKeyboardYield();");
        expect(yieldAt).toBeGreaterThan(0);
        expect(source.indexOf("addEventListener(\"keydown\"")).toBeGreaterThan(yieldAt);
        expect(source).toContain("installFileDropGuard();");
      } else {
        expect(source, entry).toMatch(/installHostKeyboardBridge\(/);
      }
    }
  });

  test("a page without native focus leaves every offered key to Emacs, untouched", () => {
    const hasFocus = document.hasFocus;
    document.hasFocus = () => false;
    try {
      withBridge("noema", (forwarded) => {
        let pageSaw = 0;
        const pageHandler = () => { pageSaw += 1; };
        window.addEventListener("keydown", pageHandler);
        try {
          for (const init of [
            { key: "x", code: "KeyX", ctrlKey: true },
            { key: "ArrowDown", code: "ArrowDown" },
            { key: "Enter", code: "Enter" },
            { key: "ArrowLeft", code: "ArrowLeft", metaKey: true },
          ]) {
            const event = trusted(new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true }));
            document.body.dispatchEvent(event);
            // Not default-prevented: WebKit declines it and Emacs handles it.
            expect(event.defaultPrevented).toBe(false);
          }
        } finally {
          window.removeEventListener("keydown", pageHandler);
        }
        expect(pageSaw).toBe(0);
        expect(forwarded).toEqual([]);
      });
    } finally {
      document.hasFocus = hasFocus;
    }
    // No C-x was left pending: with focus back, a plain 3 is just a 3.
    withBridge("noema", (forwarded) => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "3", code: "Digit3", bubbles: true, cancelable: true }));
      expect(forwarded).toEqual([]);
    });
  });

  test("releasing the keyboard hands native focus to the Emacs view", () => {
    const win = window as Window & { webkit?: unknown };
    const messages: string[] = [];
    win.webkit = { messageHandlers: { keyDown: { postMessage: (message: string) => messages.push(message) } } };
    try {
      withBridge("noema", () => {
        hostCommand("host-owns-keyboard", "noema");
        expect(messages).toEqual(["C-g"]);
      });
    } finally {
      delete win.webkit;
    }
  });

  test("a key Emacs recovered for the page is replayed to the page's own handlers", () => {
    const hasFocus = document.hasFocus;
    document.hasFocus = () => false;
    try {
      withBridge("noema-jupyter", () => {
        const seen: string[] = [];
        const pageHandler = (event: KeyboardEvent) => { seen.push(event.key); };
        window.addEventListener("keydown", pageHandler);
        try {
          window.dispatchEvent(new CustomEvent("noema:command", {
            detail: { command: "key", key: "ArrowDown", code: "ArrowDown", targetClient: "noema-jupyter" },
          }));
          window.dispatchEvent(new CustomEvent("noema:command", {
            detail: { command: "key", key: " ", code: "Space", targetClient: "noema-jupyter" },
          }));
        } finally {
          window.removeEventListener("keydown", pageHandler);
        }
        expect(seen).toEqual(["ArrowDown", " "]);
      });
    } finally {
      document.hasFocus = hasFocus;
    }
  });

  test("reads the client Emacs addresses from the page URL", () => {
    expect(pageClientFromLocation({ search: "?view=today&client=noema" })).toBe("noema");
    expect(pageClientFromLocation({ search: "" })).toBe("");
  });

  test("forwards Emacs chords, including Cmd+Arrow, before page shortcuts", () => {
    withBridge("noema-jupyter", (forwarded) => {
      let pageSaw = false;
      const pageHandler = () => { pageSaw = true; };
      window.addEventListener("keydown", pageHandler);
      try {
        document.body.dispatchEvent(new KeyboardEvent("keydown", {
          key: "ArrowDown", code: "ArrowDown", metaKey: true, bubbles: true, cancelable: true,
        }));
      } finally {
        window.removeEventListener("keydown", pageHandler);
      }
      expect(pageSaw).toBe(false);
      expect(forwarded).toEqual([{ key: "M-<down>", client: "noema-jupyter" }]);
    });
  });

  test("after host-owns-keyboard, arrows and text run in Emacs until a press reclaims", () => {
    withBridge("noema", (forwarded) => {
      hostCommand("host-owns-keyboard", "sibling");
      expect(hostInputFocusReleased()).toBe(false);
      hostCommand("host-owns-keyboard", "noema");
      expect(hostInputFocusReleased()).toBe(true);
      const arrow = trusted(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
      document.body.dispatchEvent(arrow);
      const letter = trusted(new KeyboardEvent("keydown", { key: "y", code: "KeyY", bubbles: true, cancelable: true }));
      document.body.dispatchEvent(letter);
      expect(arrow.defaultPrevented && letter.defaultPrevented).toBe(true);
      expect(forwarded).toEqual([
        { key: "<up>", client: "noema", hostOwned: true },
        { text: "y", key: "", client: "noema", hostOwned: true },
      ]);
      document.body.dispatchEvent(trusted(new PointerEvent("pointerdown", { bubbles: true })));
      expect(hostInputFocusReleased()).toBe(false);
      hostCommand("host-owns-keyboard");
      hostCommand("focus", "noema");
      expect(hostInputFocusReleased()).toBe(false);
    });
  });
});
