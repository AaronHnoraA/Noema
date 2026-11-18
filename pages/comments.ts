// Comments on a Noema page (C80).
//
// Select text and comment (⌘⌥M or the toolbar's Comment): the selected text is
// marked in the note (`{==text==}{>>#c-id<<}`, shared/comment-anchors.mjs) and
// highlighted, and the comment itself lives beside the note in the folder's
// journal (server/lib/note-comments.mjs).  There is no rail: the comment's card
// pops up above its text while the caret is in the highlight or the pointer
// rests on it.  A comment is a task; Emacs's collaboration panel (`H-t`) hands
// it to an agent, which changes the file through the API and marks it done.

import { EditorView } from "@codemirror/view";
import { commentAnchor, newCommentId, scanCommentAnchors, type CommentAnchor } from "../shared/comment-anchors.mjs";
import type { CommentMessage, CommentThread } from "../server/lib/note-comments.mjs";
import { authorColor } from "../src/author-color.ts";

export interface CommentsApi {
  list(file: string): Promise<{ threads: CommentThread[] }>;
  create(body: { file: string; id: string; quote: string; text: string }): Promise<unknown>;
  reply(body: { file: string; id: string; text: string }): Promise<unknown>;
  resolve(body: { file: string; id: string; resolved: boolean }): Promise<unknown>;
  edit(body: { file: string; id: string; mid?: string; text: string }): Promise<unknown>;
  remove(body: { file: string; id: string; mid?: string }): Promise<unknown>;
}

export interface CommentsHost {
  view: EditorView;
  /** The scrolling element that holds the editor; the card follows it. */
  scroller: HTMLElement;
  api: CommentsApi;
  currentFile(): string | null;
  readOnly(): boolean;
  setStatus(text: string, error?: boolean): void;
  /** Persist the document after an anchor was added or removed. */
  save(): void;
  /** A draft opens over the selection: close what else sits there. */
  onDraft?(): void;
}

export interface CommentsController {
  refresh(): Promise<void>;
  /** Start a comment on the current selection (toolbar button, Cmd-Alt-M). */
  startComment(): void;
  /** The host said FILE's threads changed. */
  changed(file: string): void;
  /** The document text changed (the editor's onChange). */
  documentChanged(): void;
  /** The selection settled (the editor's onSelectionChange). */
  selectionChanged(): void;
  /** Whether a new comment is being written over the selection. */
  drafting(): boolean;
  destroy(): void;
}

interface Draft { from: number; to: number; quote: string }

function initials(name: string): string {
  return (name.match(/[\p{L}\p{N}]/u)?.[0] ?? "?").toUpperCase();
}

export function relativeTime(at: string, now = Date.now()): string {
  const ms = now - Date.parse(at);
  if (!Number.isFinite(ms)) return "";
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h`;
  return new Date(Date.parse(at)).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, title: string, action: () => void, className = ""): HTMLButtonElement {
  const node = element("button", className, label);
  node.type = "button";
  node.title = title;
  node.addEventListener("mousedown", (event) => event.preventDefault());
  node.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); action(); });
  return node;
}

/** Return where a card of HEIGHT and WIDTH goes over a text box from ABOVE to
 * BELOW at LEFT: above the text when it fits in VIEWPORT, else below. */
export function placeCard(left: number, above: number, below: number, height: number, width: number,
  viewport: { width: number; height: number }): { left: number; top: number; above: boolean } {
  const x = Math.max(8, Math.min(left, viewport.width - width - 8));
  return above - height - 8 >= 8
    ? { left: x, top: above - height - 8, above: true }
    : { left: x, top: Math.min(below + 8, viewport.height - height - 8), above: false };
}

export function installComments(host: CommentsHost): CommentsController {
  const { view, scroller } = host;
  const style = element("style");
  document.head.append(style);
  const card = element("article", "noema-comment-pop");
  card.hidden = true;
  card.setAttribute("role", "dialog");
  document.body.append(card);

  let threads: CommentThread[] = [];
  let anchors = new Map<string, CommentAnchor>();
  let shown: string | null = null;      // a thread id, or "draft"
  let pinned = false;                   // shown by the caret, not the pointer
  let draft: Draft | null = null;
  let hoverTimer = 0;
  let leaveTimer = 0;

  const file = () => host.currentFile();
  const report = (error: unknown) => host.setStatus(error instanceof Error ? error.message : String(error), true);

  function scanAnchors(): void {
    anchors = new Map(scanCommentAnchors(view.state.doc.toString()).map((anchor) => [anchor.id, anchor]));
  }

  /** Done comments keep a faint highlight; the shown one is stronger. */
  function paintStyle(): void {
    const rules: string[] = [];
    for (const thread of threads) {
      if (thread.status === "resolved") {
        rules.push(`.noema-comment-anchor[data-comment-id="${thread.id}"]{background:none;border-bottom:1px dashed color-mix(in srgb,#f7c948 45%,transparent)}`);
      }
    }
    if (shown && shown !== "draft") {
      rules.push(`.noema-comment-anchor[data-comment-id="${shown}"]{background:color-mix(in srgb,#f7c948 50%,transparent);border-bottom-color:#f7c948}`);
    }
    style.textContent = rules.join("\n");
  }

  async function act(call: () => Promise<unknown>, after?: () => void): Promise<void> {
    try {
      await call();
      after?.();
      await refresh();
    } catch (error) { report(error); }
  }

  /** A text box with Cancel and a primary button; Enter submits, Shift-Enter breaks, Escape cancels. */
  function composer(initial: string, label: string, submit: (text: string) => Promise<unknown> | void, cancel: () => void): HTMLElement {
    const form = element("form", "noema-comment-composer");
    const input = element("textarea");
    input.value = initial;
    input.placeholder = "Comment";
    input.rows = 2;
    const go = element("button", "noema-comment-primary", label);
    go.type = "submit";
    go.disabled = !initial.trim();
    const stop = button("Cancel", "Cancel", cancel, "noema-comment-cancel");
    input.addEventListener("input", () => {
      go.disabled = !input.value.trim();
      input.style.height = "auto";
      input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
      place();
    });
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Escape") { event.preventDefault(); cancel(); }
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); }
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      go.disabled = true;
      void Promise.resolve(submit(text)).finally(() => { go.disabled = false; });
    });
    const actions = element("div", "noema-comment-actions");
    actions.append(stop, go);
    form.append(input, actions);
    return form;
  }

  function messageNode(thread: CommentThread, message: CommentMessage, first: boolean): HTMLElement {
    const node = element("div", "noema-comment-message");
    const head = element("div", "noema-comment-head");
    const avatar = element("span", "noema-comment-avatar", initials(message.author.name));
    avatar.style.background = authorColor(message.author.name);
    const who = element("div", "noema-comment-who");
    who.append(element("strong", "", message.author.name), element("small", "", relativeTime(message.at) + (message.edited ? " · edited" : "")));
    head.append(avatar, who);
    if (first && !host.readOnly()) {
      const tools = element("div", "noema-comment-tools");
      tools.append(thread.status === "open"
        ? button("✓", "Done", () => void act(() => host.api.resolve({ file: file()!, id: thread.id, resolved: true })), "noema-comment-resolve")
        : button("↺", "Reopen", () => void act(() => host.api.resolve({ file: file()!, id: thread.id, resolved: false }))));
      const menu = element("div", "noema-comment-menu");
      menu.hidden = true;
      menu.append(
        button("Edit", "Edit this comment", () => { menu.hidden = true; editMessage(node, thread, message); }),
        button("Delete", "Delete this comment", () => { menu.hidden = true; void deleteThread(thread); }),
      );
      tools.append(button("⋮", "More", () => { menu.hidden = !menu.hidden; }, "noema-comment-more"), menu);
      head.append(tools);
    }
    node.append(head, element("div", "noema-comment-body", message.text));
    return node;
  }

  function editMessage(node: HTMLElement, thread: CommentThread, message: CommentMessage): void {
    const body = node.querySelector<HTMLElement>(".noema-comment-body")!;
    const editor = composer(message.text, "Save", (text) => act(
      () => host.api.edit({ file: file()!, id: thread.id, ...(message.mid === "m0" ? {} : { mid: message.mid }), text })),
    () => draw());
    body.replaceWith(editor);
    pinned = true;
    editor.querySelector("textarea")?.focus({ preventScroll: true });
  }

  function draw(): void {
    card.replaceChildren();
    card.classList.remove("noema-comment-pop-done");
    if (shown === "draft" && draft) {
      const head = element("div", "noema-comment-head");
      const avatar = element("span", "noema-comment-avatar", "Y");
      avatar.style.background = authorColor("You");
      head.append(avatar, element("strong", "", "You"));
      card.append(head, composer("", "Comment", (text) => submitDraft(text), () => hide(true)));
      card.hidden = false;
      queueMicrotask(() => card.querySelector("textarea")?.focus({ preventScroll: true }));
    } else {
      const thread = threads.find((item) => item.id === shown);
      if (!thread) { card.hidden = true; paintStyle(); return; }
      card.classList.toggle("noema-comment-pop-done", thread.status === "resolved");
      thread.messages.forEach((message, index) => card.append(messageNode(thread, message, index === 0)));
      const state = thread.status === "resolved" ? "Done"
        : thread.assignee?.name ? `→ ${thread.assignee.name}` : "A task: hand it to an agent from H-t";
      card.append(element("div", "noema-comment-state", state));
      card.hidden = false;
    }
    paintStyle();
    place();
  }

  /** Put the card above its text (below when there is no room), following scrolls. */
  function place(): void {
    if (card.hidden || !shown) return;
    let range: { from: number; to: number } | null = null;
    if (shown === "draft") range = draft;
    else {
      const anchor = anchors.get(shown);
      range = anchor ? { from: anchor.textFrom, to: anchor.textTo } : null;
    }
    if (!range) { hide(true); return; }
    const start = view.coordsAtPos(range.from, 1), end = view.coordsAtPos(range.to, -1);
    if (!start || !end) { card.style.visibility = "hidden"; return; }
    card.style.visibility = "";
    const { width, height } = card.getBoundingClientRect();
    const at = placeCard(start.left, Math.min(start.top, end.top), Math.max(start.bottom, end.bottom), height, width,
      { width: window.innerWidth, height: window.innerHeight });
    card.style.left = `${at.left}px`;
    card.style.top = `${at.top}px`;
    card.classList.toggle("noema-comment-pop-below", !at.above);
  }

  function show(id: string, byCaret: boolean): void {
    clearTimeout(leaveTimer);
    if (shown === id) { pinned = pinned || byCaret; return; }
    if (shown === "draft") return;
    shown = id;
    pinned = byCaret;
    draw();
  }

  function hide(force = false): void {
    if (!force && (pinned || shown === "draft")) return;
    if (shown === "draft") draft = null;
    shown = null;
    pinned = false;
    card.hidden = true;
    paintStyle();
  }

  /** The comment whose highlighted text holds the caret, or null. */
  function anchorAtCaret(): string | null {
    const range = view.state.selection.main;
    if (!range.empty) return null;
    for (const [id, anchor] of anchors) if (range.head >= anchor.textFrom && range.head <= anchor.textTo) return id;
    return null;
  }

  function followCaret(): void {
    if (shown === "draft") return;
    const id = anchorAtCaret();
    if (id && threads.some((thread) => thread.id === id)) show(id, true);
    else if (pinned && !card.contains(document.activeElement)) { pinned = false; hide(); }
  }

  function selectionToComment(): Draft | null {
    const sel = view.state.selection.main;
    if (sel.empty) return null;
    const doc = view.state.doc;
    if (doc.lineAt(sel.from).number !== doc.lineAt(sel.to).number) return null;
    const text = doc.sliceString(sel.from, sel.to);
    if (!text.trim() || /\{==|==\}/.test(text)) return null;
    for (const anchor of anchors.values()) if (sel.from < anchor.to && sel.to > anchor.from) return null;
    return { from: sel.from, to: sel.to, quote: text };
  }

  async function submitDraft(text: string): Promise<void> {
    const current = draft;
    const path = file();
    if (!current || !path) return;
    const id = newCommentId();
    try {
      await host.api.create({ file: path, id, quote: current.quote, text });
    } catch (error) { report(error); return; }
    // The comment exists before its anchor, so an anchor never points nowhere.
    if (view.state.doc.sliceString(current.from, current.to) === current.quote) {
      const anchor = commentAnchor(current.quote, id);
      view.dispatch({
        changes: { from: current.from, to: current.to, insert: anchor },
        selection: { anchor: current.from + anchor.length },
        userEvent: "comment.add",
      });
      host.save();
    } else {
      host.setStatus("The text changed while you wrote; the comment was kept without its highlight", true);
    }
    draft = null;
    shown = null;
    card.hidden = true;
    await refresh();
    view.focus();
  }

  async function deleteThread(thread: CommentThread): Promise<void> {
    await act(() => host.api.remove({ file: file()!, id: thread.id }), () => {
      const anchor = anchors.get(thread.id);
      if (anchor) {
        view.dispatch({ changes: { from: anchor.from, to: anchor.to, insert: anchor.text }, userEvent: "comment.delete" });
        host.save();
      }
      hide(true);
    });
  }

  // The pointer resting on a highlight shows its card; leaving both closes it.
  const onOver = (event: MouseEvent) => {
    const id = (event.target as HTMLElement | null)?.closest<HTMLElement>(".noema-comment-anchor")?.dataset.commentId;
    if (!id) return;
    clearTimeout(leaveTimer);
    clearTimeout(hoverTimer);
    hoverTimer = window.setTimeout(() => show(id, false), 220);
  };
  const onOut = (event: MouseEvent) => {
    if (!(event.target as HTMLElement | null)?.closest(".noema-comment-anchor")) return;
    clearTimeout(hoverTimer);
    leaveTimer = window.setTimeout(() => hide(), 260);
  };
  const onCardEnter = () => clearTimeout(leaveTimer);
  const onCardLeave = () => { leaveTimer = window.setTimeout(() => hide(), 260); };
  const onKey = (event: KeyboardEvent) => {
    // ⌘⌥M, as in Google Docs.
    if (event.metaKey && event.altKey && !event.ctrlKey && event.code === "KeyM") {
      event.preventDefault();
      event.stopPropagation();
      controller.startComment();
    } else if (event.key === "Escape" && shown) {
      hide(true);
    }
  };
  const onScroll = () => place();
  view.dom.addEventListener("mouseover", onOver);
  view.dom.addEventListener("mouseout", onOut);
  view.dom.addEventListener("keydown", onKey, true);
  card.addEventListener("mouseenter", onCardEnter);
  card.addEventListener("mouseleave", onCardLeave);
  scroller.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll);

  async function refresh(): Promise<void> {
    const path = file();
    scanAnchors();
    if (!path) { threads = []; hide(true); return; }
    try {
      threads = (await host.api.list(path)).threads;
    } catch (error) {
      threads = [];
      report(error);
    }
    if (shown && shown !== "draft" && !threads.some((thread) => thread.id === shown)) hide(true);
    else if (shown) draw();
    else paintStyle();
  }

  const controller: CommentsController = {
    refresh,
    startComment() {
      if (host.readOnly()) return;
      const candidate = selectionToComment();
      if (!candidate) {
        host.setStatus("Select some text within one line to comment on it", true);
        return;
      }
      draft = candidate;
      shown = "draft";
      pinned = true;
      host.onDraft?.();
      draw();
    },
    changed(changedFile) {
      if (changedFile && changedFile === file()) void refresh();
    },
    documentChanged() {
      scanAnchors();
      if (shown && shown !== "draft" && !anchors.has(shown)) hide(true);
      else place();
    },
    selectionChanged() {
      followCaret();
    },
    drafting: () => shown === "draft",
    destroy() {
      clearTimeout(hoverTimer);
      clearTimeout(leaveTimer);
      view.dom.removeEventListener("mouseover", onOver);
      view.dom.removeEventListener("mouseout", onOut);
      view.dom.removeEventListener("keydown", onKey, true);
      scroller.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      card.remove();
      style.remove();
    },
  };
  return controller;
}
