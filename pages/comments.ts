// Google Docs-style comments for a Noema page (C70).
//
// The commented text is marked in the source (`{==text==}{>>#c-id<<}`, see
// shared/comment-anchors.mjs); the threads live beside the note and come from
// the host.  This module draws the comment rail: one card per open thread,
// level with its text, never overlapping, the active one shifted out and
// expanded with its reply box; a "+" beside a selection starts a new comment.
// The cards and the highlighted text answer each other: clicking either
// activates both.  A person's comment is asked of the note's collaborator by
// the host and Emacs; the reply lands in the card.

import { EditorView } from "@codemirror/view";
import { commentAnchor, newCommentId, scanCommentAnchors, type CommentAnchor } from "../shared/comment-anchors.mjs";
import type { CommentMessage, CommentThread } from "../server/lib/note-comments.mjs";

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
  /** The scrolling element that holds the editor; the rail scrolls with it. */
  scroller: HTMLElement;
  api: CommentsApi;
  currentFile(): string | null;
  readOnly(): boolean;
  setStatus(text: string, error?: boolean): void;
  /** Persist the document after an anchor was added or removed. */
  save(): void;
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
  destroy(): void;
}

const RAIL_WIDTH = 288;
const GAP = 10;

interface Draft { from: number; to: number; quote: string }

function initials(name: string): string {
  return (name.match(/[\p{L}\p{N}]/u)?.[0] ?? "?").toUpperCase();
}

/** A stable colour per author, as Google Docs gives each collaborator one. */
export function authorColor(name: string): string {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return `hsl(${hash % 360} 62% 58%)`;
}

export function relativeTime(at: string, now = Date.now()): string {
  const then = Date.parse(at);
  if (!Number.isFinite(then)) return "";
  const minutes = Math.round((now - then) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h`;
  return new Date(then).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Place cards at their wanted tops without overlap; the active one keeps its place. */
export function layoutCards(cards: { id: string; top: number; height: number }[], active: string | null): Map<string, number> {
  const sorted = [...cards].sort((a, b) => a.top - b.top);
  const placed = new Map<string, number>();
  const pivot = Math.max(0, sorted.findIndex((card) => card.id === active));
  const anchorIndex = active && sorted.some((card) => card.id === active) ? pivot : 0;
  if (!sorted.length) return placed;
  placed.set(sorted[anchorIndex].id, sorted[anchorIndex].top);
  let bottom = sorted[anchorIndex].top + sorted[anchorIndex].height;
  for (let i = anchorIndex + 1; i < sorted.length; i++) {
    const top = Math.max(sorted[i].top, bottom + GAP);
    placed.set(sorted[i].id, top);
    bottom = top + sorted[i].height;
  }
  let ceiling = sorted[anchorIndex].top;
  for (let i = anchorIndex - 1; i >= 0; i--) {
    const top = Math.min(sorted[i].top, ceiling - GAP - sorted[i].height);
    placed.set(sorted[i].id, top);
    ceiling = top;
  }
  // Pushed above the page top: lay everything out downward from there instead.
  if (ceiling < 0) {
    let next = 0;
    for (const card of sorted) {
      const top = Math.max(card.top, next);
      placed.set(card.id, top);
      next = top + card.height + GAP;
    }
  }
  return placed;
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
  node.addEventListener("click", (event) => { event.stopPropagation(); action(); });
  return node;
}

export function installComments(host: CommentsHost): CommentsController {
  const { view, scroller } = host;
  const rail = element("aside", "noema-comment-rail");
  rail.setAttribute("aria-label", "Comments");
  const addButton = button("+", "Add comment (⌘⌥M)", () => controller.startComment(), "noema-comment-add");
  addButton.hidden = true;
  rail.append(addButton);
  const style = element("style");
  document.head.append(style);
  if (getComputedStyle(scroller).position === "static") scroller.style.position = "relative";
  scroller.append(rail);

  let threads: CommentThread[] = [];
  let anchors = new Map<string, CommentAnchor>();
  let active: string | null = null;
  let draft: Draft | null = null;
  let showResolved = false;
  let frame = 0;
  let loading: Promise<void> | null = null;
  const cards = new Map<string, HTMLElement>();

  const file = () => host.currentFile();

  function scanAnchors(): void {
    anchors = new Map(scanCommentAnchors(view.state.doc.toString()).map((anchor) => [anchor.id, anchor]));
  }

  /** Top of document position POS in the scroller's content, valid off screen too. */
  function topOf(pos: number): number {
    const block = view.lineBlockAt(Math.min(pos, view.state.doc.length));
    return block.top + view.documentTop - scroller.getBoundingClientRect().top + scroller.scrollTop;
  }

  function paintStyle(): void {
    const rules: string[] = [];
    for (const thread of threads) {
      if (thread.status === "resolved") {
        rules.push(`.noema-comment-anchor[data-comment-id="${thread.id}"]{background:none;border-bottom-color:transparent;cursor:text}`);
      }
    }
    if (active) {
      rules.push(`.noema-comment-anchor[data-comment-id="${active}"]{background:color-mix(in srgb,#f7c948 55%,transparent);border-bottom-color:#f7c948}`);
    }
    style.textContent = rules.join("\n");
  }

  function messageNode(thread: CommentThread, message: CommentMessage, first: boolean): HTMLElement {
    const node = element("div", "noema-comment-message");
    const head = element("div", "noema-comment-head");
    const avatar = element("span", "noema-comment-avatar", initials(message.author.name));
    avatar.style.background = authorColor(message.author.name);
    const who = element("div", "noema-comment-who");
    who.append(element("strong", "", message.author.name),
      element("small", "", relativeTime(message.at) + (message.edited ? " · edited" : "")));
    head.append(avatar, who);
    if (first && !host.readOnly()) {
      const tools = element("div", "noema-comment-tools");
      if (thread.status === "open") {
        tools.append(button("✓", "Resolve", () => void act(() => host.api.resolve({ file: file()!, id: thread.id, resolved: true }), () => {
          if (active === thread.id) active = null;
        }), "noema-comment-resolve"));
      } else {
        tools.append(button("↺", "Reopen", () => void act(() => host.api.resolve({ file: file()!, id: thread.id, resolved: false }))));
      }
      const more = button("⋮", "More", () => menu.hidden = !menu.hidden, "noema-comment-more");
      const menu = element("div", "noema-comment-menu");
      menu.hidden = true;
      menu.append(
        button("Edit", "Edit this comment", () => { menu.hidden = true; editMessage(node, thread, message); }),
        button("Delete thread", "Delete this comment thread", () => { menu.hidden = true; void deleteThread(thread); }),
      );
      tools.append(more, menu);
      head.append(tools);
    } else if (!first && !host.readOnly() && message.author.kind === "person") {
      const tools = element("div", "noema-comment-tools");
      tools.append(button("×", "Delete reply", () => void act(() => host.api.remove({ file: file()!, id: thread.id, mid: message.mid })), "noema-comment-more"));
      head.append(tools);
    }
    const body = element("div", "noema-comment-body", message.text);
    node.append(head, body);
    return node;
  }

  function editMessage(node: HTMLElement, thread: CommentThread, message: CommentMessage): void {
    const body = node.querySelector<HTMLElement>(".noema-comment-body")!;
    const editor = composer(message.text, "Save", (text) => act(
      () => host.api.edit({ file: file()!, id: thread.id, ...(message.mid === "m0" ? {} : { mid: message.mid }), text })),
    () => render());
    body.replaceWith(editor);
    editor.querySelector("textarea")?.focus({ preventScroll: true });
  }

  /** A text box with a primary button and Cancel; Cmd/Ctrl-Enter submits, Escape cancels. */
  function composer(initial: string, label: string, submit: (text: string) => Promise<unknown> | void, cancel: () => void,
    placeholder = "Reply"): HTMLElement {
    const form = element("form", "noema-comment-composer");
    const input = element("textarea");
    input.value = initial;
    input.placeholder = placeholder;
    input.rows = 2;
    const go = element("button", "noema-comment-primary", label);
    go.type = "submit";
    go.disabled = !initial.trim();
    const stop = button("Cancel", "Cancel", cancel, "noema-comment-cancel");
    input.addEventListener("input", () => {
      go.disabled = !input.value.trim();
      input.style.height = "auto";
      input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
      schedule();
    });
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Escape") { event.preventDefault(); cancel(); }
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); form.requestSubmit(); }
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

  function cardFor(thread: CommentThread): HTMLElement {
    const card = element("article", "noema-comment-card");
    card.dataset.commentId = thread.id;
    if (thread.status === "resolved") card.classList.add("noema-comment-resolved");
    if (!anchors.has(thread.id)) card.classList.add("noema-comment-detached");
    const isActive = active === thread.id;
    card.classList.toggle("noema-comment-active", isActive);
    if (thread.quote) {
      const quote = element("blockquote", "noema-comment-quote", thread.quote);
      if (!anchors.has(thread.id)) quote.title = "The commented text was removed";
      card.append(quote);
    }
    const messages = thread.messages;
    const shown = isActive || messages.length <= 3 ? messages : [messages[0], messages.at(-1)!];
    shown.forEach((message, index) => {
      card.append(messageNode(thread, message, index === 0));
      if (!isActive && messages.length > 3 && index === 0) {
        card.append(element("div", "noema-comment-folded", `${messages.length - 2} more replies`));
      }
    });
    const last = messages.at(-1);
    if (thread.status === "open" && thread.assignee && last?.author.kind === "person") {
      card.append(element("div", "noema-comment-waiting", `${thread.assignee.name} is replying…`));
    }
    if (isActive && thread.status === "open" && !host.readOnly()) {
      card.append(composer("", "Reply", async (text) => {
        await act(() => host.api.reply({ file: file()!, id: thread.id, text }));
      }, () => { active = null; render(); }, thread.assignee ? `Reply to ${thread.assignee.name}` : "Reply"));
    }
    card.addEventListener("mousedown", (event) => {
      if ((event.target as HTMLElement).closest("textarea,button")) return;
      activate(thread.id, true);
    });
    return card;
  }

  function draftCard(): HTMLElement {
    const card = element("article", "noema-comment-card noema-comment-active noema-comment-draft");
    card.dataset.commentId = "draft";
    const me = element("div", "noema-comment-head");
    const avatar = element("span", "noema-comment-avatar", "Y");
    avatar.style.background = authorColor("You");
    me.append(avatar, element("strong", "", "You"));
    card.append(me, composer("", "Comment", (text) => submitDraft(text), () => { draft = null; render(); },
      "Comment, or ask this note's collaborator"));
    return card;
  }

  function render(): void {
    for (const card of cards.values()) card.remove();
    cards.clear();
    const visible = threads.filter((thread) => showResolved || thread.status === "open");
    for (const thread of visible) {
      const card = cardFor(thread);
      cards.set(thread.id, card);
      rail.append(card);
    }
    if (draft) {
      const card = draftCard();
      cards.set("draft", card);
      rail.append(card);
      queueMicrotask(() => card.querySelector("textarea")?.focus({ preventScroll: true }));
    }
    const resolved = threads.filter((thread) => thread.status === "resolved").length;
    toggle.hidden = !resolved;
    toggle.textContent = showResolved ? "Hide resolved" : `Resolved (${resolved})`;
    const on = cards.size > 0 || resolved > 0;
    scroller.classList.toggle("noema-comments-on", on);
    paintStyle();
    schedule();
  }

  const toggle = button("", "Show or hide resolved comments", () => { showResolved = !showResolved; render(); }, "noema-comment-toggle");
  toggle.hidden = true;
  rail.append(toggle);

  function layout(): void {
    frame = 0;
    const wanted: { id: string; top: number; height: number }[] = [];
    let detached = 0;
    for (const [id, card] of cards) {
      const pos = id === "draft" ? draft?.from : anchors.get(id)?.textFrom;
      const height = card.offsetHeight || 80;
      if (pos === undefined) {
        // A thread whose text is gone sits after the anchored ones.
        wanted.push({ id, top: Number.MAX_SAFE_INTEGER / 4 + detached++, height });
      } else {
        wanted.push({ id, top: topOf(pos), height });
      }
    }
    const lastAnchored = Math.max(0, ...wanted.filter((card) => card.top < Number.MAX_SAFE_INTEGER / 8).map((card) => card.top + card.height));
    for (const card of wanted) if (card.top >= Number.MAX_SAFE_INTEGER / 8) card.top = lastAnchored + GAP;
    const tops = layoutCards(wanted, draft ? "draft" : active);
    for (const [id, card] of cards) card.style.top = `${Math.max(0, tops.get(id) ?? 0)}px`;
    toggle.style.top = "0px";
    placeAddButton();
  }

  function schedule(): void {
    if (frame) return;
    frame = typeof requestAnimationFrame === "function" ? requestAnimationFrame(layout) : (setTimeout(layout, 0) as unknown as number);
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

  function placeAddButton(): void {
    const candidate = host.readOnly() || draft || !file() ? null : selectionToComment();
    addButton.hidden = !candidate;
    if (candidate) addButton.style.top = `${topOf(candidate.from)}px`;
  }

  async function act(call: () => Promise<unknown>, after?: () => void): Promise<void> {
    try {
      await call();
      after?.();
      await refresh();
    } catch (error) {
      host.setStatus(error instanceof Error ? error.message : String(error), true);
    }
  }

  async function submitDraft(text: string): Promise<void> {
    const current = draft;
    const path = file();
    if (!current || !path) return;
    const id = newCommentId();
    try {
      await host.api.create({ file: path, id, quote: current.quote, text });
    } catch (error) {
      host.setStatus(error instanceof Error ? error.message : String(error), true);
      return;
    }
    // The thread exists before its anchor, so an anchor never points nowhere.
    if (view.state.doc.sliceString(current.from, current.to) === current.quote) {
      const anchor = commentAnchor(current.quote, id);
      view.dispatch({
        changes: { from: current.from, to: current.to, insert: anchor },
        // The caret rests after the commented text, as in Google Docs; a
        // selection over the new anchor would open its markers.
        selection: { anchor: current.from + anchor.length },
        userEvent: "comment.add",
      });
      host.save();
    } else {
      host.setStatus("The text changed while you wrote; the comment was kept without its highlight", true);
    }
    draft = null;
    active = id;
    await refresh();
  }

  async function deleteThread(thread: CommentThread): Promise<void> {
    await act(() => host.api.remove({ file: file()!, id: thread.id }), () => {
      const anchor = anchors.get(thread.id);
      if (anchor) {
        view.dispatch({ changes: { from: anchor.from, to: anchor.to, insert: anchor.text }, userEvent: "comment.delete" });
        host.save();
      }
      if (active === thread.id) active = null;
    });
  }

  function activate(id: string | null, fromCard = false): void {
    if (active === id) return;
    active = id;
    render();
    if (id && fromCard) {
      const anchor = anchors.get(id);
      if (anchor) view.dispatch({ effects: EditorView.scrollIntoView(anchor.textFrom, { y: "nearest" }) });
    }
  }

  const onEditorClick = (event: MouseEvent) => {
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>(".noema-comment-anchor");
    const id = target?.dataset.commentId;
    if (id && threads.some((thread) => thread.id === id && thread.status === "open")) activate(id);
    else if (active && !draft) activate(null);
  };
  view.dom.addEventListener("click", onEditorClick);
  const resize = typeof ResizeObserver === "function" ? new ResizeObserver(() => schedule()) : null;
  resize?.observe(scroller);
  resize?.observe(view.contentDOM);

  async function refresh(): Promise<void> {
    const path = file();
    scanAnchors();
    if (!path) { threads = []; render(); return; }
    const run = (async () => {
      try {
        threads = (await host.api.list(path)).threads;
      } catch (error) {
        threads = [];
        host.setStatus(error instanceof Error ? error.message : String(error), true);
      }
      if (active && !threads.some((thread) => thread.id === active && thread.status === "open")) active = null;
      render();
    })();
    loading = run;
    await run;
    if (loading === run) loading = null;
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
      active = null;
      render();
    },
    changed(changedFile) {
      if (changedFile && changedFile === file()) void refresh();
    },
    documentChanged() {
      const before = [...anchors.keys()].join(",");
      scanAnchors();
      if ([...anchors.keys()].join(",") !== before) render();
      else schedule();
    },
    selectionChanged() {
      schedule();
    },
    destroy() {
      if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
      resize?.disconnect();
      view.dom.removeEventListener("click", onEditorClick);
      rail.remove();
      style.remove();
      scroller.classList.remove("noema-comments-on");
    },
  };
  void RAIL_WIDTH;
  return controller;
}
