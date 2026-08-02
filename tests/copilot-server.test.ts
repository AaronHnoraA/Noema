import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

// @ts-ignore The server is a Node ESM module outside the TS app graph.
import { configureCopilotBridgeRequest, handleCopilotRequest, offsetToPosition, positionToOffset, shutdownCopilot } from "../server/lib/copilot.mjs";

describe("copilot server helpers", () => {
  test("maps markdown offsets to LSP positions and back", () => {
    const text = "alpha\nbeta\nc";
    expect(offsetToPosition(text, 0)).toEqual({ line: 0, character: 0 });
    expect(offsetToPosition(text, 8)).toEqual({ line: 1, character: 2 });
    expect(positionToOffset(text, { line: 1, character: 2 })).toBe(8);
    expect(positionToOffset(text, { line: 9, character: 2 })).toBe(text.length);
  });

  test("tracks pane focus without starting a local language server", async () => {
    configureCopilotBridgeRequest(null);
    await shutdownCopilot();

    await handleCopilotRequest("focus", { file: "/tmp/a.md", clientId: "pane-a" });
    await handleCopilotRequest("focus", { file: "/tmp/a.md", clientId: "pane-b" });
    let log = await handleCopilotRequest("log") as {
      client?: { clients?: number; documents?: number; focusedClient?: string };
    };
    expect(log.client?.clients).toBe(2);
    expect(log.client?.documents).toBe(0);
    expect(log.client?.focusedClient).toBe("pane-b");

    await handleCopilotRequest("blur", { file: "/tmp/a.md", clientId: "pane-b" });
    log = await handleCopilotRequest("log") as {
      client?: { clients?: number; focusedClient?: string };
    };
    expect(log.client?.clients).toBe(2);
    expect(log.client?.focusedClient).toBe("");

    await handleCopilotRequest("close", { file: "/tmp/a.md", clientId: "pane-a" });
    await handleCopilotRequest("close", { file: "/tmp/a.md", clientId: "pane-b" });
    log = await handleCopilotRequest("log") as {
      client?: { clients?: number; documents?: number };
    };
    expect(log.client?.clients).toBe(0);
    expect(log.client?.documents).toBe(0);

    await shutdownCopilot();
  });

  test("reuses the configured Emacs Copilot bridge without starting a local server", async () => {
    await shutdownCopilot();
    const calls: Array<{ method: string; action?: string }> = [];
    configureCopilotBridgeRequest(async (method: string, params: { action?: string } = {}) => {
      calls.push({ method, action: params.action });
      return { ok: true, status: { message: "Emacs Copilot", kind: "Normal", busy: false } };
    });
    try {
      const result = await handleCopilotRequest("status") as { status?: { message?: string } };
      expect(result.status?.message).toBe("Emacs Copilot");
      expect(calls).toEqual([{ method: "copilot.request", action: "status" }]);
    } finally {
      await shutdownCopilot();
      configureCopilotBridgeRequest(null);
    }
  });

});
