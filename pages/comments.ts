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
import type { Collaborator, CollaboratorRef } from "./api-client.ts";
import { authorColor } from "../src/author-color.ts";
import { ediffActionEdit, ediffSide, scanEdiffBlocks, EDIFF_FEEDBACK_EVENT, type EdiffBlock, type EdiffFeedbackDetail } from "../src/ediff.ts";
import { dispatchConstructEdit } from "../src/cm6/extensions/visual/constructs/index.ts";
import { needsRenderedComparison, wordDiff } from "../src/word-diff.ts";

export interface CommentsApi {
  list(file: string): Promise<{ threads: CommentThread[] }>;
  create(body: { file: string; id: string; quote: string; text: string; to?: CollaboratorRef }): Promise<unknown>;
  reply(body: { file: string; id: string; text: string; to?: CollaboratorRef }): Promise<unknown>;
  resolve(body: { file: string; id: string; resolved: boolean }): Promise<unknown>;
  edit(body: { file: string; id: string; mid?: string; text: string }): Promise<unknown>;
  remove(body: { file: string; id: string; mid?: string }): Promise<unknown>;
  /** The note's collaborators (C71); absent where there is no Emacs. */
  collaborators?: {
    list(file: string): Promise<Collaborator[]>;
    show(who: Collaborator): Promise<unknown>;
    create(agent: string, file: string): Promise<unknown>;
  };
}

/** Agents a page can start as a collaborator of the note. */
export const COLLABORATOR_AGENTS = [["claude", "Claude"], ["codex", "Codex"]] as const;

export function collaboratorName(who: Collaborator): string {
  return who.name || who.agent || who.buffer;
}

/** A short word for what a collaborator is doing. */
export function collaboratorState(who: Collaborator): "working" | "needs you" | "idle" | "disconnected" {
  if (who.processState === "disconnected" || who.processState === "dead") return "disconnected";
  if (who.attention) return "needs you";
  if (who.busy || who.turnState === "running" || who.turnState === "stopping") return "working";
  return "idle";
}

/** The mention being typed before CARET in TEXT: its start and query, or null. */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const match = /(?:^|\s)@([^\s@]*)$/u.exec(text.slice(0, caret));
  return match ? { start: caret - match[1].length - 1, query: match[1] } : null;
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
  /** The host said FILE's collaborators changed. */
  collaboratorsChanged(file: string): void;
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

export { authorColor };

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

function avatarFor(name: string, size = 28): HTMLElement {
  const node = element("span", "noema-comment-avatar", initials(name));
  node.style.background = authorColor(name);
  if (size !== 28) Object.assign(node.style, { width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.46)}px` });
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
  // Proposals read in place, Google-style, with their controls on the rail (C72).
  scroller.classList.add("noema-review-rail");
  scroller.append(rail);

  let threads: CommentThread[] = [];
  let collaborators: Collaborator[] = [];
  const bar = element("div", "noema-collab-bar");
  bar.setAttribute("aria-label", "Collaborators");
  bar.hidden = true;
  document.body.append(bar);
  let anchors = new Map<string, CommentAnchor>();
  // Agents' proposals (`ediff` blocks), shown as suggestion cards (C72).
  let suggestions: EdiffBlock[] = [];
  let active: string | null = null;
  let draft: Draft | null = null;
  let showResolved = false;
  let frame = 0;
  let loading: Promise<void> | null = null;
  const cards = new Map<string, HTMLElement>();

  const file = () => host.currentFile();

  function scanAnchors(): void {
    const source = view.state.doc.toString();
    anchors = new Map(scanCommentAnchors(source).map((anchor) => [anchor.id, anchor]));
    suggestions = source.includes("#+begin ediff") ? scanEdiffBlocks(source).filter((block) => !block.error) : [];
  }

  const suggestionKey = (block: EdiffBlock) => `s:${block.from}`;
  const suggestionSignature = () => suggestions.map((block) => `${block.from}:${block.end}:${block.rejected}:${block.comments.length}`).join(",");

  /** Apply ACTION to the proposal at FROM, one undo step like the card's own buttons. */
  function actOnSuggestion(from: number, action: "accept" | "reject" | "comment", message = ""): void {
    try {
      const edit = ediffActionEdit(view.state.doc.toString(), from, action, message);
      dispatchConstructEdit(view, {
        changes: edit,
        selection: action === "accept" ? { anchor: edit.from + edit.insert.length } : undefined,
      }, `ediff.${action}`);
      host.save();
    } catch (error) { report(error); }
  }

  function summaryNode(block: EdiffBlock): HTMLElement {
    const node = element("div", "noema-suggestion-summary");
    const before = ediffSide(block, "old").replace(/\n$/, "");
    const after = ediffSide(block, "new").replace(/\n$/, "");
    const changes = needsRenderedComparison(before + after) ? null : wordDiff(before, after);
    const clip = (text: string) => text.length > 160 ? `${text.slice(0, 157)}…` : text;
    if (changes) {
      for (const change of changes) {
        if (change.kind === "same" && change.text.length > 40) {
          node.append(element("span", "", `${change.text.slice(0, 18)}…${change.text.slice(-18)}`));
        } else {
          node.append(element(change.kind === "del" ? "del" : change.kind === "ins" ? "ins" : "span", "", clip(change.text)));
        }
      }
    } else {
      if (before.trim()) node.append(element("del", "", clip(before)));
      if (after.trim()) node.append(element("ins", "", clip(after)));
    }
    return node;
  }

  function suggestionCard(block: EdiffBlock): HTMLElement {
    const key = suggestionKey(block);
    const card = element("article", "noema-comment-card noema-suggestion-card");
    card.dataset.commentId = key;
    const name = block.author?.name ?? "Suggestion";
    card.style.setProperty("--noema-suggestion-author", authorColor(name));
    if (block.rejected) card.classList.add("noema-comment-resolved");
    const isActive = active === key;
    card.classList.toggle("noema-comment-active", isActive);
    const head = element("div", "noema-comment-head");
    const who = element("div", "noema-comment-who");
    who.append(element("strong", "", name), element("small", "", block.rejected ? "Rejected suggestion" : `Suggested: ${block.title}`));
    head.append(avatarFor(name), who);
    if (!host.readOnly() && !block.rejected) {
      const tools = element("div", "noema-comment-tools");
      tools.append(
        button("✓", "Accept suggestion", () => actOnSuggestion(block.from, "accept"), "noema-comment-resolve"),
        button("✕", "Reject suggestion", () => actOnSuggestion(block.from, "reject"), "noema-suggestion-reject"),
      );
      head.append(tools);
    }
    card.append(head, summaryNode(block));
    for (const message of block.comments) card.append(element("div", "noema-comment-body noema-suggestion-comment", message));
    if (isActive && !host.readOnly()) {
      card.append(composer("", "Comment", (text) => {
        actOnSuggestion(block.from, "comment", text);
        // The saved comment goes back to the proposing agent, as Send feedback does.
        const fresh = scanEdiffBlocks(view.state.doc.toString()).find((item) => item.from === block.from);
        if (fresh) {
          const detail: EdiffFeedbackDetail = { from: fresh.from, to: fresh.end, source: view.state.doc.sliceString(fresh.from, fresh.end) };
          view.dom.dispatchEvent(new CustomEvent<EdiffFeedbackDetail>(EDIFF_FEEDBACK_EVENT, { bubbles: true, cancelable: true, detail }));
        }
        active = null;
        render();
      }, () => { active = null; render(); }, `Reply to ${name}`));
    }
    card.addEventListener("mousedown", (event) => {
      if ((event.target as HTMLElement).closest("textarea,button")) return;
      activate(key, false);
      view.dispatch({ effects: EditorView.scrollIntoView(block.from, { y: "nearest" }) });
    });
    return card;
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
  function composer(initial: string, label: string, submit: (text: string, to?: CollaboratorRef) => Promise<unknown> | void,
    cancel: () => void, placeholder = "Reply"): HTMLElement {
    const form = element("form", "noema-comment-composer");
    const input = element("textarea");
    // @-mentions, as in Google Docs: the chosen collaborator answers (C71).
    let mentioned: Collaborator | null = null;
    const picker = element("div", "noema-comment-mentions");
    picker.hidden = true;
    let choices: Collaborator[] = [];
    let chosen = 0;
    const showPicker = () => {
      const mention = mentionAt(input.value, input.selectionStart ?? input.value.length);
      choices = mention
        ? collaborators.filter((who) => collaboratorName(who).toLowerCase().includes(mention.query.toLowerCase()))
        : [];
      picker.replaceChildren(...choices.map((who, index) => {
        const item = button(collaboratorName(who), `Ask ${collaboratorName(who)}`, () => choose(index), "noema-comment-mention");
        item.prepend(avatarFor(collaboratorName(who), 18));
        if (index === chosen) item.classList.add("noema-comment-mention-active");
        return item;
      }));
      picker.hidden = !choices.length;
    };
    const choose = (index: number) => {
      const who = choices[index];
      const caret = input.selectionStart ?? input.value.length;
      const mention = mentionAt(input.value, caret);
      if (!who || !mention) return;
      const name = collaboratorName(who);
      input.value = `${input.value.slice(0, mention.start)}@${name} ${input.value.slice(caret)}`;
      const at = mention.start + name.length + 2;
      input.setSelectionRange(at, at);
      mentioned = who;
      picker.hidden = true;
      input.dispatchEvent(new Event("input"));
    };
    input.value = initial;
    input.placeholder = placeholder;
    input.rows = 2;
    const go = element("button", "noema-comment-primary", label);
    go.type = "submit";
    go.disabled = !initial.trim();
    const stop = button("Cancel", "Cancel", cancel, "noema-comment-cancel");
    input.addEventListener("input", () => {
      chosen = 0;
      showPicker();
      go.disabled = !input.value.trim();
      input.style.height = "auto";
      input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
      schedule();
    });
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (!picker.hidden && choices.length) {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          chosen = (chosen + (event.key === "ArrowDown" ? 1 : choices.length - 1)) % choices.length;
          showPicker();
          return;
        }
        if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); choose(chosen); return; }
        if (event.key === "Escape") { event.preventDefault(); picker.hidden = true; return; }
      }
      if (event.key === "Escape") { event.preventDefault(); cancel(); }
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); form.requestSubmit(); }
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      go.disabled = true;
      // A mention still in the text names who answers.
      const who = mentioned && text.includes(`@${collaboratorName(mentioned)}`) ? mentioned
        : collaborators.find((candidate) => text.includes(`@${collaboratorName(candidate)}`)) ?? null;
      const to = who ? { buffer: who.buffer, nativeSessionId: who.nativeSessionId } : undefined;
      void Promise.resolve(submit(text, to)).finally(() => { go.disabled = false; });
    });
    const actions = element("div", "noema-comment-actions");
    actions.append(stop, go);
    form.append(input, picker, actions);
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
    if (thread.assignee) {
      const assignee = element("div", "noema-comment-assignee", `→ ${thread.assignee.name}`);
      card.insertBefore(assignee, card.querySelector(".noema-comment-message"));
    }
    const last = messages.at(-1);
    if (thread.status === "open" && thread.assignee && last?.author.kind === "person") {
      card.append(element("div", "noema-comment-waiting", `${thread.assignee.name} is replying…`));
    }
    if (isActive && thread.status === "open" && !host.readOnly()) {
      card.append(composer("", "Reply", async (text, to) => {
        await act(() => host.api.reply({ file: file()!, id: thread.id, text, ...(to ? { to } : {}) }));
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
    card.append(me, composer("", "Comment", (text, to) => submitDraft(text, to), () => { draft = null; render(); },
      collaborators.length ? "Comment, or @mention a collaborator" : "Comment"));
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
    for (const block of suggestions) {
      const card = suggestionCard(block);
      cards.set(suggestionKey(block), card);
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
      const pos = id === "draft" ? draft?.from
        : id.startsWith("s:") ? Number(id.slice(2))
          : anchors.get(id)?.textFrom;
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

  async function submitDraft(text: string, to?: CollaboratorRef): Promise<void> {
    const current = draft;
    const path = file();
    if (!current || !path) return;
    const id = newCommentId();
    try {
      await host.api.create({ file: path, id, quote: current.quote, text, ...(to ? { to } : {}) });
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
    // A suggestion read in place activates its card (C72).
    const proposal = (event.target as HTMLElement | null)?.closest<HTMLElement>(".noema-ediff");
    const from = Number(proposal?.dataset.cmSourceFrom);
    if (proposal && suggestions.some((block) => block.from === from)) { activate(`s:${from}`); return; }
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>(".noema-comment-anchor");
    const id = target?.dataset.commentId;
    if (id && threads.some((thread) => thread.id === id && thread.status === "open")) activate(id);
    else if (active && !draft) activate(null);
  };
  view.dom.addEventListener("click", onEditorClick);
  const resize = typeof ResizeObserver === "function" ? new ResizeObserver(() => schedule()) : null;
  resize?.observe(scroller);
  resize?.observe(view.contentDOM);

  function renderBar(): void {
    const path = file();
    const api = host.api.collaborators;
    bar.hidden = !path || !api || host.readOnly();
    if (bar.hidden || !api || !path) return;
    const chips = collaborators.map((who) => {
      const name = collaboratorName(who);
      const state = collaboratorState(who);
      const chip = button("", `${name} — ${state}. Open the chat`, () => void api.show(who).catch(report), "noema-collab-chip");
      chip.dataset.state = state;
      chip.append(avatarFor(name, 22), element("span", "noema-collab-name", name), element("span", "noema-collab-dot"));
      return chip;
    });
    const add = button("+", "Add a collaborator to this note", () => menu.hidden = !menu.hidden, "noema-collab-add");
    const menu = element("div", "noema-collab-menu");
    menu.hidden = true;
    for (const [agent, label] of COLLABORATOR_AGENTS) {
      menu.append(button(`New ${label} collaborator`, `Start ${label} on this note`, () => {
        menu.hidden = true;
        host.setStatus(`Starting ${label} on this note…`);
        void api.create(agent, path).then(() => loadCollaborators()).catch(report);
      }));
    }
    bar.replaceChildren(...chips, add, menu);
  }

  function report(error: unknown): void {
    host.setStatus(error instanceof Error ? error.message : String(error), true);
  }

  async function loadCollaborators(): Promise<void> {
    const path = file();
    const api = host.api.collaborators;
    if (!path || !api) { collaborators = []; renderBar(); return; }
    try { collaborators = await api.list(path); } catch { collaborators = []; }
    renderBar();
  }

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
      if (active && !active.startsWith("s:") && !threads.some((thread) => thread.id === active && thread.status === "open")) active = null;
      render();
    })();
    loading = run;
    await run;
    if (loading === run) loading = null;
  }


  const controller: CommentsController = {
    async refresh() {
      await Promise.all([refresh(), loadCollaborators()]);
    },
    collaboratorsChanged(changedFile) {
      if (changedFile && changedFile === file()) void loadCollaborators();
    },
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
      const before = [...anchors.keys()].join(",") + "|" + suggestionSignature();
      scanAnchors();
      if ([...anchors.keys()].join(",") + "|" + suggestionSignature() !== before) render();
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
      bar.remove();
      style.remove();
      scroller.classList.remove("noema-comments-on", "noema-review-rail");
    },
  };
  void RAIL_WIDTH;
  return controller;
}
