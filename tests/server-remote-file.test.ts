import { afterEach, describe, expect, test } from "@voidzero-dev/vite-plus-test";

// @ts-ignore The server is a Node ESM module outside the TS app graph.
import { configureExternalFileProvider } from "../server/lib/state.mjs";
// @ts-ignore The server is a Node ESM module outside the TS app graph.
import { readNote } from "../server/lib/index.mjs";
// @ts-ignore The server is a Node ESM module outside the TS app graph.
import { saveNote } from "../server/lib/save.mjs";

afterEach(() => {
  configureExternalFileProvider(null);
});

describe("Remote-backed Markdown files", () => {
  test("read and save preserve the logical /fs identity", async () => {
    const file = "/fs:aaron-wsl2:/srv/notes/remote.md";
    let content = "# Remote title\n\nInitial\n";
    let mtimeMs = 1000;
    configureExternalFileProvider({
      owns(candidate: string) {
        return candidate.startsWith("/fs:");
      },
      async read(candidate: string) {
        return {
          file: candidate,
          content,
          mtimeMs,
          size: Buffer.byteLength(content, "utf8"),
        };
      },
      async write(body: { file: string; content: string; baseMtimeMs: number }) {
        expect(body.file).toBe(file);
        expect(body.baseMtimeMs).toBe(mtimeMs);
        content = body.content;
        mtimeMs += 1000;
        return {
          ok: true,
          file,
          mtimeMs,
          size: Buffer.byteLength(content, "utf8"),
        };
      },
    });

    const opened = await readNote(file) as Record<string, unknown>;
    expect(opened).toMatchObject({
      type: "open",
      file,
      title: "Remote title",
      content,
      standalone: true,
      remote: true,
      mtimeMs,
    });

    const saved = await saveNote({
      file,
      content: "# Remote title\n\nUpdated\n",
      clientId: "remote-test",
      seq: 1,
      baseMtimeMs: mtimeMs,
      refresh: "deferred",
    }) as Record<string, unknown>;
    expect(saved).toMatchObject({
      type: "saved",
      ok: true,
      file,
      standalone: true,
      remote: true,
      notesRefresh: "deferred",
      mtimeMs: 2000,
    });
    expect(content).toContain("Updated");
  });

  test("provider conflicts are returned without losing logical identity", async () => {
    const file = "/fs:remote:/tmp/conflict.md";
    configureExternalFileProvider({
      owns(candidate: string) {
        return candidate.startsWith("/fs:");
      },
      async read(candidate: string) {
        return { file: candidate, content: "# Conflict\n", mtimeMs: 5000, size: 11 };
      },
      async write() {
        return {
          ok: false,
          conflict: true,
          file,
          message: "File changed on the remote target.",
          mtimeMs: 6000,
          size: 12,
        };
      },
    });

    const saved = await saveNote({
      file,
      content: "# Local edit\n",
      clientId: "remote-conflict-test",
      seq: 1,
      baseMtimeMs: 5000,
    }) as Record<string, unknown>;
    expect(saved).toMatchObject({
      type: "saved",
      ok: false,
      conflict: true,
      file,
      standalone: true,
      mtimeMs: 6000,
    });
  });
});

