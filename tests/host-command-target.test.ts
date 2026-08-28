import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hostCommandTargetsClient } from "../aaronnote/host-command-target.ts";
import { provesHostInputFocus } from "../aaronnote/host-input-focus.ts";

const mainSource = readFileSync(join(process.cwd(), "aaronnote", "main.ts"), "utf8");

describe("host command client targeting", () => {
  test("keeps untargeted host commands as broadcasts", () => {
    expect(hostCommandTargetsClient({ command: "refresh" }, "client-a")).toBe(true);
    expect(hostCommandTargetsClient(null, "client-a")).toBe(true);
  });

  test("accepts only this xwidget client's targeted commands", () => {
    expect(hostCommandTargetsClient({ command: "resume", targetClient: "client-a" }, "client-a")).toBe(true);
    expect(hostCommandTargetsClient({ command: "pause", targetClient: "client-b" }, "client-a")).toBe(false);
    expect(hostCommandTargetsClient({ command: "pause", targetClient: "client-a" }, "")).toBe(false);
  });

  test("treats a bare client as the event's subject, never as an address", () => {
    // `client-closed` names the client that went away. Reading it as a routing
    // address would deliver the broadcast only to the page that no longer
    // exists, so every remaining renderer must still run it.
    expect(hostCommandTargetsClient({ command: "client-closed", client: "client-b" }, "client-a")).toBe(true);
    expect(hostCommandTargetsClient({ command: "note-saved", client: "client-b" }, "")).toBe(true);
  });

  test("renderer filters before applying pause or resume", () => {
    const start = mainSource.indexOf("function runHostCommand");
    const handler = mainSource.slice(start, start + 1_600);
    expect(handler).toContain("hostCommandTargetsClient(detail, rendererClient)");
    expect(handler.indexOf("hostCommandTargetsClient")).toBeLessThan(handler.indexOf("const body"));
  });

  test("routing is decided in exactly one place", () => {
    // A second filter on the SSE listener used to compare against
    // `currentClient`, which stays empty until openInitialFile() runs — so a
    // sibling pane's pause was accepted during startup.
    expect(mainSource.match(/hostCommandTargetsClient\(/gu)?.length).toBe(1);
    const listenerStart = mainSource.indexOf('window.addEventListener("aaronnote:command"');
    const listener = mainSource.slice(listenerStart, mainSource.indexOf("});", listenerStart));
    expect(listener).not.toContain("currentClient");
    // `currentClient` must carry the page identity from module load, not from
    // the first note open, or the startup window is unrouted.
    expect(mainSource).toContain("let currentClient = rendererClient;");
    expect(mainSource).not.toContain('currentClient = initialParams.get("client")');
  });
});

describe("web host command addressing", () => {
  const hostSource = readFileSync(join(process.cwd(), "web-host.mjs"), "utf8");

  test("an Emacs command carries a routing address", () => {
    const start = hostSource.indexOf("async function handleEmacsCommand");
    const handler = hostSource.slice(start, hostSource.indexOf("if (body.type === \"client-close\")", start));
    expect(handler).toContain("detail.targetClient = String(body.client);");
  });

  test("client-closed announces a subject and reaches every surviving renderer", () => {
    const start = hostSource.indexOf("function closeEditorClient");
    const handler = hostSource.slice(start, start + 1_400);
    const payloadStart = handler.indexOf('broadcast("command", {');
    const payload = handler.slice(payloadStart, handler.indexOf("});", payloadStart));
    expect(payload).toContain("closedClient: client,");
    expect(payload).not.toContain("targetClient");
  });
});

describe("stale host pause recovery", () => {
  test("only trusted input acquisition proves this page has focus", () => {
    expect(provesHostInputFocus({ type: "keydown", isTrusted: true })).toBe(true);
    expect(provesHostInputFocus({ type: "pointerdown", isTrusted: true })).toBe(true);
    expect(provesHostInputFocus({ type: "beforeinput", isTrusted: true })).toBe(true);
    expect(provesHostInputFocus({ type: "compositionstart", isTrusted: true })).toBe(true);
    expect(provesHostInputFocus({ type: "paste", isTrusted: true })).toBe(true);
  });

  test("rejects synthetic events and events a background surface can receive", () => {
    // replayEditorKeydown re-dispatches a synthetic keydown at CM6; it must
    // never be able to manufacture foreground state.
    expect(provesHostInputFocus({ type: "keydown", isTrusted: false })).toBe(false);
    expect(provesHostInputFocus({ type: "wheel", isTrusted: true })).toBe(false);
    expect(provesHostInputFocus({ type: "mousemove", isTrusted: true })).toBe(false);
    expect(provesHostInputFocus({ type: "focusin", isTrusted: true })).toBe(false);
  });

  test("the renderer drops the host pause locally and reports the fact", () => {
    const start = mainSource.indexOf("function recoverFromStaleHostPause");
    expect(start).toBeGreaterThan(-1);
    const handler = mainSource.slice(start, start + 600);
    expect(handler).toContain('pauseReasons.has("host")');
    expect(handler).toContain('setPausedReason("host", false)');
    // Without the report Emacs still believes the pane is paused, so the next
    // genuine background transition is deduplicated away and a hidden page
    // stays fully awake.
    expect(handler).toContain("api.emacs.inputFocus");
  });
});
