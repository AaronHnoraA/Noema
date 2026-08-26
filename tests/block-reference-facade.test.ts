import { afterEach, describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { api } from "../aaronnote/api-client.ts";

afterEach(() => {
  delete window.aaronnoteApi;
});

describe("block-reference browser facade", () => {
  test("keeps the typed API on the existing narrow shared-host bridge", async () => {
    const id = "0198fc34-7b32-7a11-8cb4-6c40e3b33d68";
    const calls: string[] = [];
    window.aaronnoteApi = {
      notes: {
        async resolveBlock(candidate: string) {
          calls.push(candidate);
          return {
            type: "block-reference-location",
            source: "kernel-block-index",
            id,
            file: "/notes/target.md",
            path: "/target.md",
            line: 7,
            blockType: "NodeParagraph",
          };
        },
      },
    };

    await expect(api.notes.resolveBlock(id)).resolves.toMatchObject({
      source: "kernel-block-index",
      id,
      file: "/notes/target.md",
      line: 7,
    });
    expect(calls).toEqual([id]);
  });

  test("wires the shared host channel to the production editor event", () => {
    const root = process.cwd();
    const host = readFileSync(join(root, "web-host.mjs"), "utf8");
    const editor = readFileSync(join(root, "aaronnote", "main.ts"), "utf8");
    expect(host).toContain('"aaronnote:api:notes:resolve-block"');
    expect(host).toContain("resolveBlock: function(id)");
    expect(editor).toContain('document.addEventListener("aaronnote:open-block-ref"');
    expect(editor).toContain("api.notes.resolveBlock(id)");
    expect(editor).toContain("markdownBlockSourceOffset(markdown, location.id, location.line)");
  });
});
