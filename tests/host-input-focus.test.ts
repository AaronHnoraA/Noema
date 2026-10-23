import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import {
  holdsInputAgainstHostPause,
  hostInputFocusEventTypes,
  hostInputFocusReleased,
  provesHostInputFocus,
  reclaimHostInputFocus,
  releaseHostInputFocus,
} from "../pages/host-input-focus.ts";
import { handleHostOwnedKey, hostOwnedKeyFromEvent } from "../pages/xwidget-key-guard.ts";

function trusted(event: KeyboardEvent): KeyboardEvent {
  Object.defineProperty(event, "isTrusted", { value: true });
  return event;
}

function withForwarded(run: (forwarded: unknown[]) => void): void {
  const win = window as Window & { noemaApi?: unknown };
  const previous = win.noemaApi;
  const forwarded: unknown[] = [];
  win.noemaApi = { emacs: { key: async (payload: unknown) => { forwarded.push(payload); } } };
  try {
    run(forwarded);
  } finally {
    win.noemaApi = previous;
    reclaimHostInputFocus();
  }
}

describe("Emacs xwidget input-focus recovery", () => {
  test("accepts only trusted events that prove the page owns keyboard input", () => {
    for (const type of hostInputFocusEventTypes) {
      expect(provesHostInputFocus({ type, isTrusted: true } as Event)).toBe(true);
      expect(provesHostInputFocus({ type, isTrusted: false } as Event)).toBe(false);
    }
  });

  test("does not wake a background pane from passive WebKit traffic", () => {
    for (const type of ["mousemove", "mouseover", "wheel", "scroll", "visibilitychange"]) {
      expect(provesHostInputFocus({ type, isTrusted: true } as Event)).toBe(false);
    }
  });

  test("after Emacs takes the keyboard, a stray key is not proof of focus", () => {
    releaseHostInputFocus();
    try {
      expect(provesHostInputFocus({ type: "keydown", isTrusted: true } as Event)).toBe(false);
      expect(provesHostInputFocus({ type: "beforeinput", isTrusted: true } as Event)).toBe(false);
      // A real press in the page is.
      expect(provesHostInputFocus({ type: "pointerdown", isTrusted: true } as Event)).toBe(true);
    } finally {
      reclaimHostInputFocus();
    }
    expect(provesHostInputFocus({ type: "keydown", isTrusted: true } as Event)).toBe(true);
  });

  test("stray arrows go to Emacs' selected window, not the page", () => {
    withForwarded((forwarded) => {
      releaseHostInputFocus();
      const event = trusted(new KeyboardEvent("keydown", {
        key: "ArrowDown", code: "ArrowDown", shiftKey: true, bubbles: true, cancelable: true,
      }));
      document.body.dispatchEvent(event);
      expect(handleHostOwnedKey(event, { client: () => "pane" })).toBe(true);
      expect(event.defaultPrevented).toBe(true);
      expect(forwarded).toEqual([{ key: "S-<down>", client: "pane", hostOwned: true }]);
      expect(hostInputFocusReleased()).toBe(true);
    });
  });

  test("keys stay with the page while it owns the keyboard, and in its inputs", () => {
    withForwarded((forwarded) => {
      const arrow = trusted(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
      expect(handleHostOwnedKey(arrow)).toBe(false);
      releaseHostInputFocus();
      const input = document.createElement("input");
      document.body.append(input);
      const inField = trusted(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
      input.dispatchEvent(inField);
      expect(handleHostOwnedKey(inField)).toBe(false);
      input.remove();
      expect(forwarded).toEqual([]);
    });
  });

  test("typing into Emacs travels as text, chords and named keys as Emacs keys", () => {
    withForwarded((forwarded) => {
      releaseHostInputFocus();
      for (const init of [
        { key: "s", code: "KeyS" },
        { key: "中", code: "" },
        { key: "e", code: "KeyE", ctrlKey: true },
        { key: "Enter", code: "Enter" },
      ] as KeyboardEventInit[]) {
        const event = trusted(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
        document.body.dispatchEvent(event);
        expect(handleHostOwnedKey(event, { client: () => "pane" })).toBe(true);
      }
      expect(forwarded).toEqual([
        { key: "", text: "s", client: "pane", hostOwned: true },
        { key: "", text: "中", client: "pane", hostOwned: true },
        { key: "C-e", client: "pane", hostOwned: true },
        { key: "RET", client: "pane", hostOwned: true },
      ]);
    });
  });

  test("modifier-only and composing keys are not sent", () => {
    expect(hostOwnedKeyFromEvent(new KeyboardEvent("keydown", { key: "Shift" }))).toBeNull();
    expect(hostOwnedKeyFromEvent(new KeyboardEvent("keydown", { key: "a", isComposing: true }))).toBeNull();
    expect(hostOwnedKeyFromEvent(new KeyboardEvent("keydown", { key: "F5" }))).toEqual({ key: "<f5>" });
  });
});

// A click inside the WebKit view does not select the Emacs window, so Emacs
// could pause the pane just clicked; pausing releases the editor's focus, and
// the caret that had appeared vanished.
describe("a host pause while the user is in the page", () => {
  test("is refused only while the page holds the native keyboard and Emacs has not taken it", () => {
    try {
      reclaimHostInputFocus();
      expect(holdsInputAgainstHostPause({ hasFocus: () => true })).toBe(true);
      // Another window or application has the keyboard: the pause is real.
      expect(holdsInputAgainstHostPause({ hasFocus: () => false })).toBe(false);
      // A host without the focus query cannot prove anything.
      expect(holdsInputAgainstHostPause({})).toBe(false);
      // Emacs announced that it took the keyboard: the pause is real.
      releaseHostInputFocus();
      expect(holdsInputAgainstHostPause({ hasFocus: () => true })).toBe(false);
    } finally {
      reclaimHostInputFocus();
    }
  });
});
