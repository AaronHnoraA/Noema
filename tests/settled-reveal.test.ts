import { afterEach, beforeEach, describe, expect, test, vi } from "@voidzero-dev/vite-plus-test";

import { revealWhileLayoutSettles } from "../aaronnote/settled-reveal.ts";

describe("revealing the cursor while a note settles", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("repeats the reveal until layout has settled", () => {
    const reveal = vi.fn();
    revealWhileLayoutSettles({ reveal, stillCurrent: () => true });
    expect(reveal).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    // Now, two frames, and the five settle delays.
    expect(reveal).toHaveBeenCalledTimes(8);
    vi.advanceTimersByTime(5000);
    expect(reveal).toHaveBeenCalledTimes(8);
  });

  for (const type of ["wheel", "pointerdown", "mousedown", "touchstart", "keydown"]) {
    test(`gives the viewport to the reader on ${type}`, () => {
      const reveal = vi.fn();
      revealWhileLayoutSettles({ reveal, stillCurrent: () => true });
      vi.advanceTimersByTime(130);
      const before = reveal.mock.calls.length;
      expect(before).toBeGreaterThan(1);
      // The reader scrolls away, or clicks somewhere that does not move the
      // cursor: no later timer may bring the old cursor line back.
      document.body.dispatchEvent(new Event(type, { bubbles: true }));
      vi.advanceTimersByTime(2000);
      expect(reveal).toHaveBeenCalledTimes(before);
    });
  }

  test("stops when the selection or document it was armed for is gone", () => {
    const reveal = vi.fn();
    let current = true;
    revealWhileLayoutSettles({ reveal, stillCurrent: () => current });
    vi.advanceTimersByTime(60);
    const before = reveal.mock.calls.length;
    current = false;
    vi.advanceTimersByTime(2000);
    expect(reveal).toHaveBeenCalledTimes(before);
  });

  test("a second note cancels the first note's reveals", () => {
    const first = vi.fn();
    const second = vi.fn();
    const cancelFirst = revealWhileLayoutSettles({ reveal: first, stillCurrent: () => true });
    vi.advanceTimersByTime(60);
    const before = first.mock.calls.length;
    cancelFirst();
    revealWhileLayoutSettles({ reveal: second, stillCurrent: () => true });
    vi.advanceTimersByTime(2000);
    expect(first).toHaveBeenCalledTimes(before);
    expect(second).toHaveBeenCalledTimes(8);
  });

  test("leaves no listener behind once it has finished", () => {
    const added: string[] = [];
    const removed: string[] = [];
    const scope = {
      requestAnimationFrame: (callback: FrameRequestCallback) => window.requestAnimationFrame(callback),
      cancelAnimationFrame: (handle: number) => window.cancelAnimationFrame(handle),
      setTimeout: ((handler: () => void, delay?: number) => window.setTimeout(handler, delay)) as Window["setTimeout"],
      clearTimeout: ((handle?: number) => window.clearTimeout(handle)) as Window["clearTimeout"],
      addEventListener: ((type: string) => { added.push(type); }) as Window["addEventListener"],
      removeEventListener: ((type: string) => { removed.push(type); }) as Window["removeEventListener"],
    };
    revealWhileLayoutSettles({ reveal: () => {}, stillCurrent: () => true, window: scope });
    expect(added).toHaveLength(5);
    expect(removed).toHaveLength(0);
    vi.advanceTimersByTime(1000);
    expect([...removed].sort()).toEqual([...added].sort());
  });
});
