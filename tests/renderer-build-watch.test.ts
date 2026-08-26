import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

// @ts-ignore Node ESM helper lives outside the TypeScript application graph.
import { createRendererBuildWatcher, readRendererBuildGeneration } from "../server/lib/renderer-build-watch.mjs";

describe("renderer build receipt", () => {
  test("watches only completed generations and coalesces filesystem noise", async () => {
    const root = await mkdtemp(join(tmpdir(), "noema-renderer-build-"));
    const receiptFile = join(root, "dist", ".noema-renderer-build.json");
    let notify: ((event: string, filename?: string) => void) | undefined;
    let closed = false;
    const updates: Array<{ generation: string; previous: string }> = [];
    try {
      await mkdir(join(root, "dist"));
      await writeFile(receiptFile, '{"generation":"first"}\n');
      const watcher = await createRendererBuildWatcher({
        receiptFile,
        debounceMs: 0,
        onBuild: (update: { generation: string; previous: string }) => updates.push(update),
        watchImpl: (_directory: string, _options: unknown, callback: typeof notify) => {
          notify = callback;
          return { close() { closed = true; } };
        },
      });

      expect(watcher.generation).toBe("first");
      notify?.("change", "unrelated.js");
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(updates).toEqual([]);

      await writeFile(receiptFile, "incomplete");
      notify?.("rename", ".noema-renderer-build.json");
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(updates).toEqual([]);

      await writeFile(receiptFile, '{"generation":"second"}\n');
      notify?.("rename", ".noema-renderer-build.json");
      notify?.("change", ".noema-renderer-build.json");
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(updates).toEqual([{ generation: "second", previous: "first" }]);
      expect(watcher.generation).toBe("second");

      watcher.close();
      watcher.close();
      expect(closed).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("treats missing or partial receipts as no completed build", async () => {
    const root = await mkdtemp(join(tmpdir(), "noema-renderer-build-read-"));
    try {
      expect(await readRendererBuildGeneration(join(root, "missing.json"))).toBe("");
      const receipt = join(root, "receipt.json");
      await writeFile(receipt, '{"generation":42}\n');
      expect(await readRendererBuildGeneration(receipt)).toBe("");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
