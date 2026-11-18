import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import type { EditorView } from "@codemirror/view";
import { createEditor } from "../src/editor-api.ts";
import { installComments, placeCard, type CommentsApi } from "../pages/comments.ts";
import type { CommentThread } from "../server/lib/note-comments.mjs";

const thread = (id: string, text: string, extra: Partial<CommentThread> = {}): CommentThread => ({
  id, note: "SAI.md", quote: "fixed field", status: "open", createdAt: "2026-11-17T08:00:00Z",
  author: { name: "You", kind: "person" }, assignee: null,
  messages: [{ mid: "m0", author: { name: "You", kind: "person" }, text, at: "2026-11-17T08:00:00Z" }],
  ...extra,
});

function mount(content: string, threads: CommentThread[]) {
  const scroller = document.createElement("div");
  document.body.append(scroller);
  const editor = createEditor(scroller, { kernel: "cm6", initialContent: content });
  const view = editor.view as unknown as EditorView;
  const calls: any[] = [];
  let saved = 0;
  const api: CommentsApi = {
    list: async () => ({ threads }),
    create: async (body) => { calls.push(["create", body]); threads.push(thread(body.id, body.text, { quote: body.quote })); },
    reply: async (body) => { calls.push(["reply", body]); },
    resolve: async (body) => { calls.push(["resolve", body]); const t = threads.find((x) => x.id === body.id); if (t) t.status = body.resolved ? "resolved" : "open"; },
    edit: async (body) => { calls.push(["edit", body]); },
    remove: async (body) => { calls.push(["remove", body]); },
  };
  const comments = installComments({ view, scroller, api, currentFile: () => "/notes/SAI.md", readOnly: () => false,
    setStatus: () => {}, save: () => { saved++; } });
  return { view, comments, calls, saved: () => saved,
    pop: () => document.querySelector<HTMLElement>(".noema-comment-pop")!,
    done: () => { comments.destroy(); editor.destroy(); scroller.remove(); } };
}

describe("C80 comments pop up above their text", () => {
  test("C80 there is no rail; the card waits hidden", async () => {
    const { pop, comments, done } = mount("plain\n", []);
    try {
      await comments.refresh();
      expect(document.querySelector(".noema-comment-rail")).toBeNull();
      expect(pop().hidden).toBe(true);
    } finally { done(); }
  });

  test("C80 Cmd-Option-M drafts above the selection; Enter stores the comment then its anchor", async () => {
    const content = "The fixed field here.\n";
    const { view, pop, calls, saved, comments, done } = mount(content, []);
    try {
      await comments.refresh();
      const from = content.indexOf("fixed");
      view.dispatch({ selection: { anchor: from, head: from + "fixed field".length } });
      view.dom.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyM", key: "µ", metaKey: true, altKey: true, bubbles: true }));
      expect(pop().hidden).toBe(false);
      const input = pop().querySelector<HTMLTextAreaElement>("textarea")!;
      input.value = "Why fixed?";
      input.dispatchEvent(new Event("input"));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(calls[0][0]).toBe("create");
      expect(calls[0][1]).toMatchObject({ quote: "fixed field", text: "Why fixed?" });
      expect(view.state.doc.toString()).toBe(`The {==fixed field==}{>>#${calls[0][1].id}<<} here.\n`);
      expect(saved()).toBe(1);
    } finally { done(); }
  });

  test("C80 the caret in the highlight shows its card; leaving closes it", async () => {
    const content = "The {==fixed field==}{>>#c-1111<<} here.\n";
    const { view, pop, comments, done } = mount(content, [thread("c-1111", "Check this", { assignee: { name: "codex·SAI", session: "t" } as any })]);
    try {
      await comments.refresh();
      view.dispatch({ selection: { anchor: content.indexOf("fixed") + 2 } });
      comments.selectionChanged();
      expect(pop().hidden).toBe(false);
      expect(pop().querySelector(".noema-comment-body")?.textContent).toBe("Check this");
      expect(pop().querySelector(".noema-comment-state")?.textContent).toBe("→ codex·SAI");
      view.dispatch({ selection: { anchor: content.length - 1 } });
      comments.selectionChanged();
      expect(pop().hidden).toBe(true);
    } finally { done(); }
  });

  test("C80 Done resolves the comment and the card says so", async () => {
    const content = "The {==fixed field==}{>>#c-1111<<} here.\n";
    const { view, pop, calls, comments, done } = mount(content, [thread("c-1111", "Check this")]);
    try {
      await comments.refresh();
      view.dispatch({ selection: { anchor: content.indexOf("fixed") + 2 } });
      comments.selectionChanged();
      pop().querySelector<HTMLButtonElement>(".noema-comment-resolve")!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(calls).toContainEqual(["resolve", { file: "/notes/SAI.md", id: "c-1111", resolved: true }]);
      expect(pop().classList.contains("noema-comment-pop-done")).toBe(true);
      expect(pop().querySelector(".noema-comment-state")?.textContent).toBe("Done");
    } finally { done(); }
  });

  test("C80 the card goes above its text, below when there is no room", () => {
    expect(placeCard(100, 300, 320, 120, 300, { width: 1000, height: 800 })).toEqual({ left: 100, top: 172, above: true });
    expect(placeCard(900, 60, 80, 120, 300, { width: 1000, height: 800 })).toEqual({ left: 692, top: 88, above: false });
  });
});
