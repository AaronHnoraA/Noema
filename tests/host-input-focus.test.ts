import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { hostInputFocusEventTypes, provesHostInputFocus } from "../aaronnote/host-input-focus.ts";

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
});
