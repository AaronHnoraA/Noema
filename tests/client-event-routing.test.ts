import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import {
  MAX_CLIENT_LIFECYCLE_STATES,
  clientLifecycleReplay,
  eventTargetsClient,
  forgetClientLifecycle,
  normalizeEventClient,
  rememberClientLifecycle,
} from "../server/lib/client-event-routing.mjs";

describe("per-renderer SSE command routing", () => {
  test("broadcasts untargeted events but strictly isolates targeted clients", () => {
    expect(eventTargetsClient({ command: "notes-index-changed" }, "client-a")).toBe(true);
    expect(eventTargetsClient({ command: "pause", targetClient: "client-a" }, "client-a")).toBe(true);
    expect(eventTargetsClient({ command: "pause", targetClient: "client-a" }, "client-b")).toBe(false);
    expect(eventTargetsClient({ command: "pause", targetClient: "client-a" }, "")).toBe(false);
  });

  test("normalizes URL client identities without truncating canonical paths", () => {
    expect(normalizeEventClient("  pane-a  ")).toBe("pane-a");
    expect(normalizeEventClient(42)).toBe("");
    expect(normalizeEventClient("x".repeat(800))).toHaveLength(800);
  });

  test("replays the latest explicit lifecycle fact after reconnect", () => {
    const states = new Map<string, "pause" | "resume">();
    expect(rememberClientLifecycle(states, { command: "pause", targetClient: "pane-a" })).toBe(true);
    expect(rememberClientLifecycle(states, { command: "pause", targetClient: "pane-b" })).toBe(true);
    expect(rememberClientLifecycle(states, { command: "resume", targetClient: "pane-a" })).toBe(true);

    expect(clientLifecycleReplay(states, "pane-a")).toEqual({
      command: "resume",
      targetClient: "pane-a",
      client: "pane-a",
      replay: true,
    });
    expect(clientLifecycleReplay(states, "pane-b")).toEqual({
      command: "pause",
      targetClient: "pane-b",
      client: "pane-b",
      replay: true,
    });
    expect(clientLifecycleReplay(states, "pane-c")).toBeNull();
  });

  test("ignores broadcasts and non-state commands and forgets closed clients", () => {
    const states = new Map<string, "pause" | "resume">();
    expect(rememberClientLifecycle(states, { command: "pause" })).toBe(false);
    expect(rememberClientLifecycle(states, { command: "save", targetClient: "pane-a" })).toBe(false);
    expect(states.size).toBe(0);

    rememberClientLifecycle(states, { command: "pause", targetClient: "pane-a" });
    expect(forgetClientLifecycle(states, "pane-a")).toBe(true);
    expect(clientLifecycleReplay(states, "pane-a")).toBeNull();
  });

  test("bounds replay memory after clients disappear without a close event", () => {
    const states = new Map<string, "pause" | "resume">();
    for (let index = 0; index <= MAX_CLIENT_LIFECYCLE_STATES; index += 1) {
      rememberClientLifecycle(states, {
        command: index % 2 ? "resume" : "pause",
        targetClient: `pane-${index}`,
      });
    }

    expect(states.size).toBe(MAX_CLIENT_LIFECYCLE_STATES);
    expect(clientLifecycleReplay(states, "pane-0")).toBeNull();
    expect(clientLifecycleReplay(states, `pane-${MAX_CLIENT_LIFECYCLE_STATES}`)).not.toBeNull();

    // Re-observing an old live client refreshes its LRU position.
    rememberClientLifecycle(states, { command: "resume", targetClient: "pane-1" });
    rememberClientLifecycle(states, { command: "pause", targetClient: "new-pane" });
    expect(clientLifecycleReplay(states, "pane-1")?.command).toBe("resume");
    expect(clientLifecycleReplay(states, "pane-2")).toBeNull();
  });
});
