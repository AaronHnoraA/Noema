import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import type { EditorView } from "@codemirror/view";
import { createEditor } from "../src/editor-api.ts";
import { installComments, layoutCards, type CommentsApi } from "../pages/comments.ts";
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
    resolve: async (body) => { calls.push(["resolve", body]); },
    edit: async (body) => { calls.push(["edit", body]); },
    remove: async (body) => { calls.push(["remove", body]); },
  };
  const comments = installComments({
    view, scroller, api, currentFile: () => "/notes/SAI.md", readOnly: () => false,
    setStatus: () => {}, save: () => { saved++; },
  });
  return { scroller, view, comments, calls, saved: () => saved,
    done: () => { comments.destroy(); editor.destroy(); scroller.remove(); } };
}

describe("C70 comment rail", () => {
  test("C70 cards never overlap and the active one keeps its place", () => {
    const tops = layoutCards([
      { id: "a", top: 100, height: 80 }, { id: "b", top: 120, height: 60 }, { id: "c", top: 400, height: 40 },
    ], "b");
    expect(tops.get("b")).toBe(120);
    expect(tops.get("a")! + 80).toBeLessThanOrEqual(120);
    expect(tops.get("c")).toBe(400);
  });

  test("C70 cards pushed above the page top are laid out downward instead", () => {
    const tops = layoutCards([{ id: "a", top: 0, height: 200 }, { id: "b", top: 50, height: 100 }], "b");
    expect(tops.get("a")).toBe(0);
    expect(tops.get("b")).toBeGreaterThanOrEqual(210);
  });

  test("C70 an open thread shows as a card with its author, text and resolve button", async () => {
    const { scroller, comments, done } = mount("The {==fixed field==}{>>#c-1111<<} here.\n", [thread("c-1111", "Why fixed?")]);
    try {
      await comments.refresh();
      const card = scroller.querySelector<HTMLElement>('.noema-comment-card[data-comment-id="c-1111"]')!;
      expect(card).toBeTruthy();
      expect(card.textContent).toContain("Why fixed?");
      expect(card.textContent).toContain("You");
      expect(card.querySelector(".noema-comment-resolve")).toBeTruthy();
      expect(scroller.classList.contains("noema-comments-on")).toBe(true);
    } finally { done(); }
  });

  test("C70 clicking the highlighted text activates its card and opens the reply box", async () => {
    const { scroller, comments, done } = mount("The {==fixed field==}{>>#c-1111<<} here.\n", [thread("c-1111", "Why fixed?")]);
    try {
      await comments.refresh();
      scroller.querySelector<HTMLElement>(".noema-comment-anchor")!.click();
      const card = scroller.querySelector<HTMLElement>('.noema-comment-card[data-comment-id="c-1111"]')!;
      expect(card.classList.contains("noema-comment-active")).toBe(true);
      expect(card.querySelector("textarea")?.placeholder).toBe("Reply");
    } finally { done(); }
  });

  test("C70 commenting on a selection creates the thread first, then wraps the text", async () => {
    const content = "The fixed field here.\n";
    const { view, scroller, comments, calls, saved, done } = mount(content, []);
    try {
      await comments.refresh();
      const from = content.indexOf("fixed field");
      view.dispatch({ selection: { anchor: from, head: from + "fixed field".length } });
      comments.selectionChanged();
      comments.startComment();
      const form = scroller.querySelector<HTMLFormElement>(".noema-comment-draft form")!;
      form.querySelector("textarea")!.value = "Why fixed?";
      form.querySelector("textarea")!.dispatchEvent(new Event("input"));
      form.requestSubmit();
      await new Promise((resolve) => setTimeout(resolve, 10));
      const [kind, body] = calls[0];
      expect(kind).toBe("create");
      expect(body).toMatchObject({ file: "/notes/SAI.md", quote: "fixed field", text: "Why fixed?" });
      expect(view.state.doc.toString()).toBe(`The {==fixed field==}{>>#${body.id}<<} here.\n`);
      expect(view.state.selection.main.empty).toBe(true);
      expect(saved()).toBe(1);
    } finally { done(); }
  });

  test("C70 a selection across lines or over another comment cannot start one", async () => {
    const content = "one\ntwo {==x==}{>>#c-1111<<}\n";
    const { view, scroller, comments, done } = mount(content, [thread("c-1111", "q")]);
    try {
      await comments.refresh();
      view.dispatch({ selection: { anchor: 0, head: 6 } });
      comments.startComment();
      expect(scroller.querySelector(".noema-comment-draft")).toBeNull();
    } finally { done(); }
  });

  test("C70 resolving hides the card", async () => {
    const threads = [thread("c-1111", "Why?", { assignee: { name: "claude·SAI" } })];
    const { scroller, comments, calls, done } = mount("The {==fixed field==}{>>#c-1111<<} here.\n", threads);
    try {
      await comments.refresh();
      scroller.querySelector<HTMLButtonElement>(".noema-comment-resolve")!.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(calls[0]).toEqual(["resolve", { file: "/notes/SAI.md", id: "c-1111", resolved: true }]);
      threads[0] = { ...threads[0], status: "resolved" };
      await comments.refresh();
      expect(scroller.querySelector('.noema-comment-card[data-comment-id="c-1111"]')).toBeNull();
      expect(scroller.querySelector<HTMLElement>(".noema-comment-toggle")?.textContent).toBe("Resolved (1)");
    } finally { done(); }
  });

  test("C73 the page shows no agents: no header, no mention picker", async () => {
    const { scroller, comments, done } = mount("The {==fixed field==}{>>#c-1111<<} here.\n",
      [thread("c-1111", "Why?", { assignee: { name: "claude·SAI" } })]);
    try {
      await comments.refresh();
      expect(document.querySelector(".noema-collab-bar")).toBeNull();
      expect(scroller.querySelector(".noema-comment-waiting")).toBeNull();
      expect(scroller.querySelector(".noema-comment-assignee")).toBeNull();
    } finally { done(); }
  });

  test("C72 a proposal is a suggestion card: accept and reject act on the note", async () => {
    const content = "Intro\n#+begin ediff Clarify\n@@ediff-author {\"name\":\"claude·SAI\"}\n-The field is fixed.\n+The field is finite and fixed.\n#+end ediff\nEnd\n";
    const { view, scroller, comments, saved, done } = mount(content, []);
    try {
      await comments.refresh();
      expect(scroller.classList.contains("noema-review-rail")).toBe(true);
      const card = scroller.querySelector<HTMLElement>(".noema-suggestion-card")!;
      expect(card.textContent).toContain("claude·SAI");
      expect(card.textContent).toContain("Suggested: Clarify");
      expect(card.querySelector("ins")?.textContent).toBe("finite and ");
      card.querySelector<HTMLButtonElement>(".noema-comment-resolve")!.click();
      expect(view.state.doc.toString()).toBe("Intro\nThe field is finite and fixed.\nEnd\n");
      expect(saved()).toBe(1);
      comments.documentChanged();
      expect(scroller.querySelector(".noema-suggestion-card")).toBeNull();
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } });
      comments.documentChanged();
      scroller.querySelector<HTMLButtonElement>(".noema-suggestion-reject")!.click();
      expect(view.state.doc.toString()).toContain("@@ediff-status rejected");
    } finally { done(); }
  });
});
