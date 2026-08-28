import { afterEach, describe, expect, test, vi } from "@voidzero-dev/vite-plus-test";
import { createRendererActivityGate } from "../src/renderer-activity.ts";

describe("shared renderer activity gate", () => {
  test("fans out one idempotent transition to every renderer participant", () => {
    const calls: string[] = [];
    const gate = createRendererActivityGate([
      { setPaused: (paused) => calls.push(`measure:${paused}`) },
      { setPaused: (paused) => calls.push(`viewport:${paused}`) },
      { setPaused: (paused) => calls.push(`focus:${paused}`) },
    ]);

    expect(gate.isPaused()).toBe(false);
    gate.setPaused(true);
    gate.setPaused(true);
    gate.setPaused(false);
    gate.setPaused(false);

    expect(calls).toEqual([
      "measure:true",
      "viewport:true",
      "focus:true",
      "measure:false",
      "viewport:false",
      "focus:false",
    ]);
    expect(gate.isPaused()).toBe(false);
  });

  test("late participants inherit the current pause state and can be removed", () => {
    const calls: boolean[] = [];
    const gate = createRendererActivityGate();
    gate.setPaused(true);

    const remove = gate.addParticipant({ setPaused: (paused) => calls.push(paused) });
    expect(calls).toEqual([true]);

    gate.setPaused(false);
    remove();
    gate.setPaused(true);

    expect(calls).toEqual([true, false]);
  });
});


afterEach(() => {
  vi.useRealTimers();
});

describe("shared renderer lifecycle", () => {
  test("moves active -> recently-active -> quiescent and wakes on activity", () => {
    vi.useFakeTimers();
    const states: string[] = [];
    const gate = createRendererActivityGate([], {
      autoStart: true,
      onStateChange: (state) => states.push(state),
    });

    expect(gate.getState()).toBe("active");
    vi.advanceTimersByTime(249);
    expect(gate.state()).toBe("active");
    vi.advanceTimersByTime(1);
    expect(gate.state()).toBe("recently-active");
    vi.advanceTimersByTime(750);
    expect(gate.isQuiescent()).toBe(true);

    gate.notifyActivity();
    expect(gate.state()).toBe("active");
    expect(states).toEqual(["recently-active", "quiescent", "active"]);
    gate.destroy();
    expect(gate.state()).toBe("destroyed");
  });

  test("host pause is hidden, and resume starts the same lifecycle again", () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const gate = createRendererActivityGate([{
      setActivity: (state) => calls.push(state),
    }]);

    gate.setPaused(true);
    expect(gate.state()).toBe("hidden");
    gate.notifyActivity();
    expect(gate.state()).toBe("hidden");
    gate.setPaused(false);
    expect(gate.state()).toBe("active");
    expect(calls).toEqual(["hidden", "active"]);
    gate.destroy();
    expect(calls.at(-1)).toBe("destroyed");
  });

  test("a pointer release wakes a drag that outlasted the quiescent delay", () => {
    vi.useFakeTimers();
    const target = new EventTarget();
    const states: string[] = [];
    const gate = createRendererActivityGate([], {
      activityTarget: target,
      autoStart: true,
      onStateChange: (state) => states.push(state),
    });

    target.dispatchEvent(new Event("pointerdown"));
    vi.advanceTimersByTime(1_000);
    expect(gate.state()).toBe("quiescent");

    target.dispatchEvent(new Event("pointerup"));
    expect(gate.state()).toBe("active");
    expect(states).toEqual(["recently-active", "quiescent", "active"]);
    gate.destroy();
  });
});
