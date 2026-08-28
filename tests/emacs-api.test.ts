import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { createEmacsApiHandlers } from "../server/Features/Emacs/api.mjs";

describe("Emacs host API", () => {
  test("delegates note-path selection to the Emacs gateway adapter", async () => {
    const received: unknown[] = [];
    const handlers = createEmacsApiHandlers({
      apiOpenInEmacs: () => undefined,
      apiCurrentFile: () => undefined,
      apiEmacsInputFocus: () => undefined,
      apiEmacsUiState: () => undefined,
      apiEmacsKey: () => undefined,
      apiSystemOpen: () => undefined,
      apiEmacsZotero: () => undefined,
      apiChooseNotePath: async (body: unknown) => {
        received.push(body);
        return { ok: true, path: "/notes/project", relativePath: "project" };
      },
    });
    const body = { kind: "directory", root: "/notes" };

    await expect(handlers["aaronnote:api:emacs:choose-note-path"](body)).resolves.toEqual({
      ok: true,
      path: "/notes/project",
      relativePath: "project",
    });
    expect(received).toEqual([body]);
  });

  test("routes the renderer input-focus fact to the Emacs gateway adapter", async () => {
    const received: unknown[] = [];
    const handlers = createEmacsApiHandlers({
      apiOpenInEmacs: () => undefined,
      apiCurrentFile: () => undefined,
      apiEmacsInputFocus: async (body: unknown) => {
        received.push(body);
        return { ok: true };
      },
      apiEmacsUiState: () => undefined,
      apiEmacsKey: () => undefined,
      apiSystemOpen: () => undefined,
      apiEmacsZotero: () => undefined,
      apiChooseNotePath: () => undefined,
    });
    const body = { client: "aaronnote:/notes/a.md", file: "/notes/a.md" };

    await expect(handlers["aaronnote:api:emacs:input-focus"](body)).resolves.toEqual({ ok: true });
    expect(received).toEqual([body]);
  });
});
