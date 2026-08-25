import { afterEach, describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// @ts-ignore The server is a Node ESM module outside the TS app graph.
import { configure, configureMarkdownFileProvider } from "../server/lib/state.mjs";
// @ts-ignore The server is a Node ESM module outside the TS app graph.
import { readNote } from "../server/lib/index.mjs";
// @ts-ignore The server is a Node ESM module outside the TS app graph.
import { saveNote } from "../server/lib/save.mjs";

const roots: string[] = [];

afterEach(async () => {
  configureMarkdownFileProvider(null);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("server facade with desktop kernel persistence", () => {
  test("keeps Node save policy while routing source reads and writes through the provider", async () => {
    const root = await mkdtemp(join(tmpdir(), "noema-kernel-persistence-"));
    const notes = join(root, "notes");
    const file = join(notes, "a.md");
    roots.push(root);
    await mkdir(notes, { recursive: true });
    await writeFile(file, "# Initial\n", "utf8");
    configure({ root: notes, workspaceRoot: root, pluginRoot: join(root, "plugin") });

    let reads = 0;
    let writes = 0;
    configureMarkdownFileProvider({
      owns(candidate: string) {
        return candidate === file;
      },
      async read() {
        reads++;
        return { content: await readFile(file, "utf8") };
      },
      async write(body: { content: string }) {
        writes++;
        await writeFile(file, body.content, "utf8");
        return { ok: true, content: body.content };
      },
    });

    const opened = await readNote(file) as { content: string; version: string; mtimeMs: number };
    expect(opened.content).toBe("# Initial\n");
    const saved = await saveNote({
      file,
      content: "# Saved through kernel\n\nExact bytes.\n",
      clientId: "desktop-kernel-test",
      seq: 1,
      baseMtimeMs: opened.mtimeMs,
      baseVersion: opened.version,
      refresh: "deferred",
    }) as { ok?: boolean; conflict?: boolean; note?: { title?: string } };

    expect(saved).toMatchObject({ ok: true, note: { title: "Saved through kernel" } });
    expect(reads).toBeGreaterThanOrEqual(3);
    expect(writes).toBe(1);
    expect(await readFile(file, "utf8")).toBe("# Saved through kernel\n\nExact bytes.\n");
  });

  test("rejects an external edit before calling the provider write", async () => {
    const root = await mkdtemp(join(tmpdir(), "noema-kernel-conflict-"));
    const notes = join(root, "notes");
    const file = join(notes, "a.md");
    roots.push(root);
    await mkdir(notes, { recursive: true });
    await writeFile(file, "# Initial\n", "utf8");
    configure({ root: notes, workspaceRoot: root, pluginRoot: join(root, "plugin") });

    let writes = 0;
    configureMarkdownFileProvider({
      owns(candidate: string) {
        return candidate === file;
      },
      async read() {
        return { content: await readFile(file, "utf8") };
      },
      async write(body: { content: string }) {
        writes++;
        await writeFile(file, body.content, "utf8");
        return { ok: true, content: body.content };
      },
    });

    const opened = await readNote(file) as { version: string; mtimeMs: number };
    await writeFile(file, "# External\n", "utf8");
    const changed = await stat(file);
    expect(changed.mtimeMs).toBeGreaterThanOrEqual(opened.mtimeMs);
    const saved = await saveNote({
      file,
      content: "# Local\n",
      clientId: "desktop-kernel-conflict",
      seq: 1,
      baseMtimeMs: opened.mtimeMs,
      baseVersion: opened.version,
      refresh: "deferred",
    }) as { conflict?: boolean };

    expect(saved.conflict).toBe(true);
    expect(writes).toBe(0);
    expect(await readFile(file, "utf8")).toBe("# External\n");
  });

  test("fails closed when the kernel cannot provide the current source", async () => {
    const root = await mkdtemp(join(tmpdir(), "noema-kernel-outage-"));
    const notes = join(root, "notes");
    const file = join(notes, "a.md");
    roots.push(root);
    await mkdir(notes, { recursive: true });
    await writeFile(file, "# Preserved\n", "utf8");
    configure({ root: notes, workspaceRoot: root, pluginRoot: join(root, "plugin") });

    let writes = 0;
    configureMarkdownFileProvider({
      owns(candidate: string) {
        return candidate === file;
      },
      async read() {
        throw new Error("kernel unavailable");
      },
      async write() {
        writes++;
        return { ok: true, content: "# Lost\n" };
      },
    });

    await expect(saveNote({
      file,
      content: "# Local\n",
      clientId: "desktop-kernel-outage",
      seq: 1,
      force: true,
      refresh: "deferred",
    })).rejects.toThrow("kernel unavailable");
    expect(writes).toBe(0);
    expect(await readFile(file, "utf8")).toBe("# Preserved\n");
  });
});
