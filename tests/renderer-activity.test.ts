import { afterEach, describe, expect, test, vi } from "@voidzero-dev/vite-plus-test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRendererActivityGate, idleAssistAllowed } from "../src/renderer-activity.ts";

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

describe("idle-triggered assist gating", () => {
  test("a quiescent renderer still allows an idle-triggered completion", () => {
    // Copilot's own idle delay (850ms) fires just before the renderer goes
    // quiescent (1000ms). Treating quiescent as inactive cancelled the request
    // while its focus round-trip was in flight, and discarded any response that
    // arrived more than ~150ms after the last keystroke -- which is every one.
    expect(idleAssistAllowed("active")).toBe(true);
    expect(idleAssistAllowed("recently-active")).toBe(true);
    expect(idleAssistAllowed("quiescent")).toBe(true);
    expect(idleAssistAllowed("hidden")).toBe(false);
    expect(idleAssistAllowed("destroyed")).toBe(false);
  });

  test("Copilot's host predicate goes through the shared gate", () => {
    const mainSource = readFileSync(join(process.cwd(), "aaronnote", "main.ts"), "utf8");
    const start = mainSource.indexOf("  isActive: () => !serverReaderMode");
    expect(start).toBeGreaterThan(-1);
    const predicate = mainSource.slice(start, mainSource.indexOf("editorSurfaceVisible(),", start));
    expect(predicate).toContain("idleAssistAllowed(rendererActivityState)");
    expect(predicate).not.toContain('"quiescent"');
  });
});

describe("renderer activity participant wiring", () => {
  const mainSource = readFileSync(join(process.cwd(), "aaronnote", "main.ts"), "utf8");

  test("retain-and-flush participants pause only for a hidden surface", () => {
    // The gate's compatibility fallback maps a bare setPaused participant to
    // `isHidden || isQuiescent`. Anything that queues work while paused and
    // flushes it on resume must not take that path, or its queue sits unflushed
    // for the whole idle period.
    const start = mainSource.indexOf("const rendererActivity = createRendererActivityGate([");
    const list = mainSource.slice(start, mainSource.indexOf("], {", start));
    expect(list).toContain("hiddenSurfaceOnly(setMeasuredWidgetObservationPaused)");
    expect(list).toContain("hiddenSurfaceOnly(setViewportDecorationRefreshPaused)");
    expect(list).not.toContain("setPaused: setMeasuredWidgetObservationPaused");
    expect(list).not.toContain("setPaused: setViewportDecorationRefreshPaused");

    const helper = mainSource.slice(
      mainSource.indexOf("const hiddenSurfaceOnly = ("),
      start,
    );
    expect(helper).toContain('state === "hidden" || state === "destroyed"');
    expect(helper).not.toContain("quiescent");
  });
});
