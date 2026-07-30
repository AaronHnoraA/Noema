import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

// @ts-ignore The server is a Node ESM module outside the TS app graph.
import { handleCopilotRequest, offsetToPosition, positionToOffset, shutdownCopilot } from "../server/lib/copilot.mjs";

describe("copilot server helpers", () => {
  test("maps markdown offsets to LSP positions and back", () => {
    const text = "alpha\nbeta\nc";
    expect(offsetToPosition(text, 0)).toEqual({ line: 0, character: 0 });
    expect(offsetToPosition(text, 8)).toEqual({ line: 1, character: 2 });
    expect(positionToOffset(text, { line: 1, character: 2 })).toBe(8);
    expect(positionToOffset(text, { line: 9, character: 2 })).toBe(text.length);
  });

  test("tracks pane focus without starting a local language server", async () => {
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

});
