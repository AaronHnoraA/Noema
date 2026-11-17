import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commentAnchor, newCommentId, scanCommentAnchors, stripCommentAnchors } from "../shared/comment-anchors.mjs";
import { COMMENTS_FILE, createThread, deleteComment, editMessage, foldJournal, listThreads, moveThreads,
  replyThread, setThreadStatus } from "../server/lib/note-comments.mjs";

describe("C70 comment anchors", () => {
  test("C70 an anchor marks the commented text and carries only the thread id", () => {
    const source = "The {==fixed field==}{>>#c-20261117-abc123<<} and ==highlight== stay.";
    const [anchor] = scanCommentAnchors(source);
    expect(anchor).toMatchObject({ id: "c-20261117-abc123", text: "fixed field" });
    expect(source.slice(anchor.textFrom, anchor.textTo)).toBe("fixed field");
    expect(source.slice(anchor.from, anchor.to)).toBe("{==fixed field==}{>>#c-20261117-abc123<<}");
    expect(stripCommentAnchors(source)).toBe("The fixed field and ==highlight== stay.");
    expect(commentAnchor("a b", "c-20261117-abc123")).toBe("{==a b==}{>>#c-20261117-abc123<<}");
    expect(() => commentAnchor("a\nb", "c-20261117-abc123")).toThrow("one line");
    expect(newCommentId(new Date("2026-11-17T08:09:10Z"), () => 0.5)).toBe("c-20261117080910-7fffff");
  });
});

describe("C70 comment threads beside the note", () => {
  const withFolder = async (body: (dir: string) => Promise<void>) => {
    const dir = mkdtempSync(join(tmpdir(), "noema-comments-"));
    try { await body(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  };

  test("C70 a thread is kept in the folder's hidden journal and folded on read", () => withFolder(async (dir) => {
    const file = join(dir, "SAI.md");
    writeFileSync(file, "x\n");
    await createThread({ file, id: "c-1111", quote: "fixed field", text: "Why fixed?" });
    await replyThread({ file, id: "c-1111", text: "Because.", author: { name: "claude·SAI", kind: "agent", session: "tok" } });
    let [thread] = await listThreads(file);
    expect(thread).toMatchObject({ id: "c-1111", note: "SAI.md", quote: "fixed field", status: "open",
      author: { name: "You", kind: "person" } });
    expect(thread.messages.map((m: any) => [m.author.name, m.text])).toEqual([["You", "Why fixed?"], ["claude·SAI", "Because."]]);
    const lines = readFileSync(join(dir, COMMENTS_FILE), "utf8").trim().split("\n");
    expect(lines.map((line) => JSON.parse(line).op)).toEqual(["thread", "reply"]);
    await setThreadStatus({ file, id: "c-1111", resolved: true });
    expect((await listThreads(file))[0].status).toBe("resolved");
    await setThreadStatus({ file, id: "c-1111", resolved: false });
    await editMessage({ file, id: "c-1111", text: "Why is F fixed?" });
    [thread] = await listThreads(file);
    expect(thread.status).toBe("open");
    expect(thread.messages[0]).toMatchObject({ text: "Why is F fixed?" });
    await deleteComment({ file, id: "c-1111", mid: thread.messages[1].mid });
    expect((await listThreads(file))[0].messages).toHaveLength(1);
    await deleteComment({ file, id: "c-1111" });
    expect(await listThreads(file)).toEqual([]);
  }));

  test("C70 notes of one folder share the journal but not their threads", () => withFolder(async (dir) => {
    const a = join(dir, "a.md"), b = join(dir, "b.md");
    await createThread({ file: a, id: "c-aaaa", quote: "q", text: "on a" });
    await createThread({ file: b, id: "c-bbbb", quote: "q", text: "on b" });
    expect((await listThreads(a)).map((t: any) => t.id)).toEqual(["c-aaaa"]);
    expect((await listThreads(b)).map((t: any) => t.id)).toEqual(["c-bbbb"]);
    await expect(createThread({ file: a, id: "c-aaaa", quote: "q", text: "again" })).rejects.toThrow("already");
    await expect(replyThread({ file: a, id: "c-none", text: "x" })).rejects.toThrow("No such");
    await expect(createThread({ file: a, id: "bad", quote: "q", text: "x" })).rejects.toThrow("id");
  }));

  test("C70 a renamed note keeps its threads; another writer's lines are seen", () => withFolder(async (dir) => {
    const a = join(dir, "a.md");
    await createThread({ file: a, id: "c-aaaa", quote: "q", text: "on a" });
    expect(await moveThreads(a, join(dir, "renamed.md"))).toBe(1);
    expect(await listThreads(a)).toEqual([]);
    expect((await listThreads(join(dir, "renamed.md")))[0].id).toBe("c-aaaa");
    // Emacs appends on its own; the cache notices the journal grew.
    const journal = join(dir, COMMENTS_FILE);
    writeFileSync(journal, readFileSync(journal, "utf8")
      + JSON.stringify({ v: 1, op: "reply", id: "c-aaaa", mid: "m-x", author: { name: "codex", kind: "agent" }, text: "seen", at: "z" }) + "\n");
    expect((await listThreads(join(dir, "renamed.md")))[0].messages.at(-1)?.text).toBe("seen");
    expect(foldJournal("not json\n").size).toBe(0);
    const other = mkdtempSync(join(tmpdir(), "noema-comments-to-"));
    try {
      expect(await moveThreads(join(dir, "renamed.md"), join(other, "moved.md"))).toBe(1);
      expect(await listThreads(join(dir, "renamed.md"))).toEqual([]);
      const [moved] = await listThreads(join(other, "moved.md"));
      expect(moved.messages.map((m: any) => m.text)).toEqual(["on a", "seen"]);
    } finally { rmSync(other, { recursive: true, force: true }); }
  }));
});

describe("C70 comment API", () => {
  test("C70 page writes reach open pages, and a person's comment is asked of the collaborator", async () => {
    const { createCommentApiHandlers } = await import("../server/Features/Comments/api.mjs");
    const dir = mkdtempSync(join(tmpdir(), "noema-comments-api-"));
    try {
      const file = join(dir, "SAI.md");
      const changed: string[] = [], asked: any[] = [];
      const api: any = createCommentApiHandlers({ changed: (f: string) => changed.push(f), ask: (p: any) => asked.push(p) });
      await api["noema:api:comments:create"]({ file, id: "c-1234", quote: "q", text: "Why?" });
      expect(asked).toEqual([{ file, id: "c-1234", text: "Why?", quote: "q" }]);
      await api["noema:api:comments:reply"]({ file, id: "c-1234", text: "Because", author: { name: "claude", kind: "agent" } });
      expect(asked).toHaveLength(1);
      await api["noema:api:comments:create"]({ file, id: "c-5678", quote: "q", text: "Note to self", ask: false });
      expect(asked).toHaveLength(1);
      await api["noema:api:comments:resolve"]({ file, id: "c-1234" });
      const { threads } = await api["noema:api:comments:list"]({ file });
      expect(threads.map((t: any) => [t.id, t.status])).toEqual([["c-1234", "resolved"], ["c-5678", "open"]]);
      expect(changed).toHaveLength(4);
      await expect(api["noema:api:comments:list"]({ file: "rel.md" })).rejects.toThrow("absolute");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("C71 collaborators in comments", () => {
  test("C71 a mention names who answers, and collaborator changes reach pages", async () => {
    const { createCommentApiHandlers } = await import("../server/Features/Comments/api.mjs");
    const dir = mkdtempSync(join(tmpdir(), "noema-comments-to-"));
    try {
      const file = join(dir, "SAI.md");
      const asked: any[] = [], collaborators: string[] = [];
      const api: any = createCommentApiHandlers({ ask: (p: any) => asked.push(p), collaborators: (f: string) => collaborators.push(f) });
      const to = { buffer: "*Agent · claude·SAI*", nativeSessionId: "n1" };
      await api["noema:api:comments:create"]({ file, id: "c-1234", quote: "q", text: "@claude·SAI why?", to });
      expect(asked[0]).toMatchObject({ file, id: "c-1234", to });
      await api["noema:api:comments:reply"]({ file, id: "c-1234", text: "and?", to });
      expect(asked[1]).toMatchObject({ to });
      await api["noema:api:comments:collaborators-changed"]({ file });
      expect(collaborators).toEqual([file]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("C71 an agent leaves a comment on the text it names, and replies in a thread", async () => {
    const { ApiRouter } = await import("../server/infrastructure/api-router.mjs");
    const { createAgentApiHandlers } = await import("../server/Features/Agent/api.mjs");
    const { createEmacsApiHandlers } = await import("../server/Features/Emacs/api.mjs");
    const dir = mkdtempSync(join(tmpdir(), "noema-agent-comment-"));
    try {
      const file = join(dir, "SAI.md");
      let source = "# T\n\nThe fixed field is F.\n";
      const saved: any[] = [];
      const router = new ApiRouter().register(createEmacsApiHandlers({
        apiAgent: () => ({ ok: true, session: { name: "claude·SAI" } }),
      } as any));
      const call = async (channel: string, args: any[] = []): Promise<any> => {
        if (channel === "noema:api:notes:open") return { ok: true, file: args[0], content: source, version: "v1" };
        if (channel === "noema:api:notes:save") { saved.push(args[0]); source = args[0].content; return { ok: true }; }
        return router.call(channel, args);
      };
      router.register(createAgentApiHandlers({ router, call }));
      const from = source.indexOf("fixed field");
      const reply = await call("noema:api:agent:document:comment", [{ file, authorSession: "tok",
        from, to: from + "fixed field".length, oldText: "fixed field", text: "Is F finite?" }]);
      expect(reply).toMatchObject({ ok: true });
      expect(source).toBe(`# T\n\nThe {==fixed field==}{>>#${reply.thread.id}<<} is F.\n`);
      expect(saved[0]).toMatchObject({ baseVersion: "v1" });
      let [thread] = await listThreads(file);
      expect(thread).toMatchObject({ quote: "fixed field", author: { name: "claude·SAI", kind: "agent", session: "tok" } });
      await call("noema:api:agent:document:comment", [{ file, authorSession: "tok", id: thread.id, text: "Answered in §2." }]);
      [thread] = await listThreads(file);
      expect(thread.messages.at(-1)).toMatchObject({ text: "Answered in §2.", author: { kind: "agent" } });
      await expect(call("noema:api:agent:document:comment", [{ file, from, to: from + 3, oldText: "zzz", text: "x" }]))
        .rejects.toThrow("oldText");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
