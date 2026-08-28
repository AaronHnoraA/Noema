import { afterEach, describe, expect, test, vi } from "@voidzero-dev/vite-plus-test";

import {
  createFocusQuiescenceController,
  editorTextFromKeydown,
  isReplayableEditorKeydown,
  replayEditorKeydown,
  type FocusQuiescenceEditor,
} from "../src/cm6/focus-quiescence.ts";

function createHarness(options: {
  enabled?: boolean;
  visible?: () => boolean;
  pointerSelecting?: () => boolean;
  interactionBlocked?: () => boolean;
  onParkedKeydown?: (event: KeyboardEvent) => boolean;
} = {}): {
  contentDOM: HTMLElement;
  surface: HTMLElement;
  view: FocusQuiescenceEditor;
  controller: ReturnType<typeof createFocusQuiescenceController>;
  setVisible: (visible: boolean) => void;
  setPointerSelecting: (selecting: boolean) => void;
  setInteractionBlocked: (blocked: boolean) => void;
} {
  const surface = document.createElement("section");
  const contentDOM = document.createElement("div");
  contentDOM.className = "cm-content";
  contentDOM.contentEditable = "true";
  surface.appendChild(contentDOM);
  document.body.appendChild(surface);

  let visible = true;
  let pointerSelecting = false;
  let interactionBlocked = false;
  const view = { contentDOM };
  const controller = createFocusQuiescenceController({
    enabled: options.enabled ?? true,
    view,
    editorSurface: surface,
    isSurfaceVisible: options.visible ?? (() => visible),
    isPointerSelecting: options.pointerSelecting ?? (() => pointerSelecting),
    isInteractionBlocked: options.interactionBlocked ?? (() => interactionBlocked),
    onParkedKeydown: options.onParkedKeydown,
  });

  return {
    contentDOM,
    surface,
    view,
    controller,
    setVisible: (next) => { visible = next; },
    setPointerSelecting: (next) => { pointerSelecting = next; },
    setInteractionBlocked: (next) => { interactionBlocked = next; },
  };
}

function focus(contentDOM: HTMLElement): void {
  contentDOM.focus({ preventScroll: true });
}

function dispatchKey(target: EventTarget, key = "a"): void {
  target.dispatchEvent(new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
  }));
}

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("shared parked-key routing", () => {
  test("recognizes Unicode text and editor controls but not IME/system keys", () => {
    const base = { code: "KeyA", ctrlKey: false, metaKey: false, altKey: false, isComposing: false };
    expect(isReplayableEditorKeydown({ ...base, key: "中" })).toBe(true);
    expect(isReplayableEditorKeydown({ ...base, key: "😀" })).toBe(true);
    expect(isReplayableEditorKeydown({ ...base, key: "ArrowLeft" })).toBe(true);
    expect(isReplayableEditorKeydown({ ...base, key: "F5" })).toBe(false);
    expect(isReplayableEditorKeydown({ ...base, key: "Dead" })).toBe(false);
    expect(isReplayableEditorKeydown({ ...base, key: "Help", code: "Help" })).toBe(false);
    expect(isReplayableEditorKeydown({ ...base, key: "a", isComposing: true })).toBe(false);
  });

  test("normalizes legacy host aliases into the shared editor key vocabulary", () => {
    const base = { code: "KeyA", ctrlKey: false, metaKey: false, altKey: false, isComposing: false };
    expect(editorTextFromKeydown({ ...base, code: "Space", key: "Spacebar" })).toBe(" ");
    expect(editorTextFromKeydown({ ...base, key: "😀" })).toBe("😀");
    expect(editorTextFromKeydown({ ...base, key: "Return", code: "NumpadEnter" })).toBeNull();
    expect(editorTextFromKeydown({ ...base, key: "Help", code: "Help" })).toBeNull();
    expect(isReplayableEditorKeydown({ ...base, key: "Return", code: "NumpadEnter" })).toBe(true);
  });

  test("replays at CM6 contentDOM and keeps the original body event from running twice", () => {
    vi.useFakeTimers();
    let contentDOM!: HTMLElement;
    const harness = createHarness({
      onParkedKeydown: (event) => replayEditorKeydown(contentDOM, event),
    });
    contentDOM = harness.contentDOM;
    const seen: KeyboardEvent[] = [];
    const listener = (event: Event): void => {
      const keydown = event as KeyboardEvent;
      seen.push(keydown);
      // Model the normal shared renderer/CM6 path consuming the replay.
      keydown.preventDefault();
    };
    document.addEventListener("keydown", listener, true);
    try {
      focus(contentDOM);
      harness.controller.park();
      const focusSpy = vi.spyOn(contentDOM, "focus");
      const event = new KeyboardEvent("keydown", {
        key: "ArrowLeft",
        code: "ArrowLeft",
        bubbles: true,
        cancelable: true,
      });
      document.body.dispatchEvent(event);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.target).toBe(contentDOM);
      expect(seen[0]?.key).toBe("ArrowLeft");
      expect(event.defaultPrevented).toBe(true);
      expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
    } finally {
      document.removeEventListener("keydown", listener, true);
      harness.controller.destroy();
    }
  });
});

describe("shared focus quiescence controller", () => {
  test("shared renderer quiescence never blurs the active editor", () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const blur = vi.spyOn(harness.contentDOM, "blur");
    try {
      focus(harness.contentDOM);
      harness.controller.setActivity("quiescent");
      expect(blur).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(harness.contentDOM);
      harness.controller.setActivity("active");
      expect(document.activeElement).toBe(harness.contentDOM);
    } finally {
      harness.controller.destroy();
    }
  });

  test("ordinary inactivity never parks the focused CM6 contenteditable", () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const blur = vi.spyOn(harness.contentDOM, "blur");
    try {
      focus(harness.contentDOM);
      harness.controller.notifyActivity();
      vi.advanceTimersByTime(10_000);
      expect(blur).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(harness.contentDOM);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      harness.controller.destroy();
    }
  });

  test("explicit parking remains available for a hidden host surface", () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const blur = vi.spyOn(harness.contentDOM, "blur");
    try {
      focus(harness.contentDOM);
      harness.controller.park();
      expect(blur).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      harness.controller.destroy();
    }
  });

  test("wakes synchronously on a parked key event, including a detached body target", () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const focusSpy = vi.spyOn(harness.contentDOM, "focus");
    try {
      focus(harness.contentDOM);
      harness.controller.park();
      expect(document.activeElement).not.toBe(harness.contentDOM);

      dispatchKey(document.body, "x");
      expect(focusSpy).toHaveBeenLastCalledWith({ preventScroll: true });
      expect(document.activeElement).toBe(harness.contentDOM);
    } finally {
      harness.controller.destroy();
    }
  });

  test("lets the shared renderer preserve the first printable key after parking", () => {
    vi.useFakeTimers();
    const handled: string[] = [];
    const harness = createHarness({
      onParkedKeydown: (event) => {
        if (event.key.length !== 1) return false;
        handled.push(event.key);
        return true;
      },
    });
    const focusSpy = vi.spyOn(harness.contentDOM, "focus");
    try {
      focus(harness.contentDOM);
      harness.controller.park();
      const event = new KeyboardEvent("keydown", { key: "中", bubbles: true, cancelable: true });
      document.body.dispatchEvent(event);
      expect(handled).toEqual(["中"]);
      expect(event.defaultPrevented).toBe(true);
      expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
    } finally {
      harness.controller.destroy();
    }
  });

  test("does not steal focus from native controls or blocked surfaces", () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const outsideInput = document.createElement("input");
    document.body.appendChild(outsideInput);
    const focusSpy = vi.spyOn(harness.contentDOM, "focus");
    try {
      focus(harness.contentDOM);
      harness.controller.park();
      focusSpy.mockClear();

      outsideInput.focus();
      dispatchKey(outsideInput, "q");
      expect(focusSpy).not.toHaveBeenCalled();

      outsideInput.blur();
      harness.setInteractionBlocked(true);
      dispatchKey(document.body, "q");
      expect(focusSpy).not.toHaveBeenCalled();
    } finally {
      harness.controller.destroy();
    }
  });

  test("explicit parking cannot interrupt composition or pointer selection", () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const blur = vi.spyOn(harness.contentDOM, "blur");
    try {
      focus(harness.contentDOM);
      harness.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      harness.controller.park();
      expect(blur).not.toHaveBeenCalled();
      harness.contentDOM.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      harness.controller.park();
      expect(blur).toHaveBeenCalledTimes(1);

      focus(harness.contentDOM);
      harness.setPointerSelecting(true);
      harness.contentDOM.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      harness.controller.park();
      expect(blur).toHaveBeenCalledTimes(1);
      harness.setPointerSelecting(false);
      harness.contentDOM.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
      harness.controller.park();
      expect(blur).toHaveBeenCalledTimes(2);
    } finally {
      harness.controller.destroy();
    }
  });

  test("pointerdown wakes before CM6 pointer handling and does not intercept drag", () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const focusSpy = vi.spyOn(harness.contentDOM, "focus");
    try {
      focus(harness.contentDOM);
      harness.controller.park();
      focusSpy.mockClear();
      const event = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });
      harness.contentDOM.dispatchEvent(event);
      expect(focusSpy).toHaveBeenLastCalledWith({ preventScroll: true });
      expect(event.defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(harness.contentDOM);
      harness.contentDOM.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    } finally {
      harness.controller.destroy();
    }
  });

  test("pause parks immediately and resume never refocuses automatically", () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const focusSpy = vi.spyOn(harness.contentDOM, "focus");
    const blur = vi.spyOn(harness.contentDOM, "blur");
    try {
      focus(harness.contentDOM);
      focusSpy.mockClear();
      harness.controller.setPaused(true);
      expect(blur).toHaveBeenCalledTimes(1);
      harness.controller.setPaused(false);
      vi.advanceTimersByTime(1_000);
      expect(focusSpy).not.toHaveBeenCalled();
    } finally {
      harness.controller.destroy();
    }
  });

  test("disabled hosts keep the shared renderer untouched", () => {
    vi.useFakeTimers();
    const harness = createHarness({ enabled: false });
    const focusSpy = vi.spyOn(harness.contentDOM, "focus");
    const blur = vi.spyOn(harness.contentDOM, "blur");
    try {
      focus(harness.contentDOM);
      harness.controller.notifyActivity();
      vi.advanceTimersByTime(10_000);
      dispatchKey(document.body, "a");
      expect(blur).not.toHaveBeenCalled();
      expect(focusSpy).toHaveBeenCalledTimes(1);
    } finally {
      harness.controller.destroy();
    }
  });

  test("destroy removes the event wake path and owns no timer", () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const focusSpy = vi.spyOn(harness.contentDOM, "focus");
    const blur = vi.spyOn(harness.contentDOM, "blur");
    try {
      focus(harness.contentDOM);
      harness.controller.park();
      focusSpy.mockClear();
      harness.controller.destroy();
      vi.advanceTimersByTime(10_000);
      dispatchKey(document.body, "a");
      expect(blur).toHaveBeenCalledTimes(1);
      expect(focusSpy).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      harness.controller.destroy();
    }
  });
});
