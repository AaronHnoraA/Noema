import type { Editor } from "../src/lib.ts";
import { ORG_META_PREAMBLE_LINE_LIMIT, orgMetaSummaryRangeFromLines } from "../src/org-meta.ts";
import {
  inlineTagAnchorsFromText,
  markdownHeadingsFromText,
  tocIndexFromState,
  type InlineTagAnchor,
  type MarkdownHeading,
} from "../src/cm6/toc-index.ts";
import type { NoteSummary } from "./types.ts";

type OpenNoteOptions = { newWindow?: boolean; equationTag?: string; inlineTag?: string };

export { inlineTagAnchorsFromText, markdownHeadingsFromText };
export type { InlineTagAnchor };

export type FloatingTocPanel = {
  update: () => void;
  toggle: () => void;
};

export type OrgEnvAnchor = {
  kind: string;
  title: string;
  pos: number;
  to: number;
};

/** Scan org-env opening lines for TOC navigation without materializing the doc. */
export function orgEnvAnchorsFromText(doc: { lines: number; line(n: number): { from: number; to: number; text: string } }): OrgEnvAnchor[] {
  const anchors: OrgEnvAnchor[] = [];
  const metaSummaryRange = orgMetaSummaryRangeFromLines(doc);
  let fence = "";
  let displayMath = false;
  for (let n = 1; n <= doc.lines; n += 1) {
    const line = doc.line(n);
    if (metaSummaryRange && line.from >= metaSummaryRange.from && line.to <= metaSummaryRange.to) continue;
    const trimmed = line.text.trim();
    const fenceMatch = /^(?: {0,3})(`{3,}|~{3,})/.exec(line.text);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (!fence) fence = marker[0]!.repeat(marker.length);
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = "";
      continue;
    }
    if (fence) continue;
    if (/^\\\[\s*$/.test(trimmed)) { displayMath = true; continue; }
    if (/^\\\]\s*$/.test(trimmed)) { displayMath = false; continue; }
    if (displayMath) continue;
    const match = /^\s*#\+\s*begin\s+(\S+)(?:\s+(.+?))?\s*$/i.exec(line.text);
    if (!match) continue;
    const kind = match[1]!.toLowerCase();
    if (kind === "lean4") continue;
    if (kind === "meta" && n > ORG_META_PREAMBLE_LINE_LIMIT) continue;
    anchors.push({ kind, title: (match[2] ?? "").trim(), pos: line.from, to: line.to });
  }
  return anchors;
}

const ORG_ENV_TOC_PRESENTATION: Record<string, { mark: string; color: string }> = {
  definition: { mark: "◇", color: "var(--c-def, #ffd86a)" },
  defn: { mark: "◇", color: "var(--c-def, #ffd86a)" },
  define: { mark: "◇", color: "var(--c-def, #ffd86a)" },
  theorem: { mark: "∎", color: "var(--c-thm, #8effa8)" },
  thm: { mark: "∎", color: "var(--c-thm, #8effa8)" },
  lemma: { mark: "△", color: "var(--c-lemma, #95c7ff)" },
  corollary: { mark: "▽", color: "var(--c-cor, #d2a8ff)" },
  cor: { mark: "▽", color: "var(--c-cor, #d2a8ff)" },
  proposition: { mark: "◆", color: "var(--c-prop, #ffc5cf)" },
  prop: { mark: "◆", color: "var(--c-prop, #ffc5cf)" },
  property: { mark: "◆", color: "var(--c-prop, #ffc5cf)" },
  proof: { mark: "□", color: "var(--c-proof, #7ee7ff)" },
  example: { mark: "※", color: "var(--c-example, #e8b85f)" },
  convention: { mark: "C", color: "var(--c-convention, #f0a6ca)" },
  axiom: { mark: "A", color: "var(--c-axiom, #ffcf70)" },
  assumption: { mark: "A", color: "var(--c-assumption, #e6b86a)" },
  conjecture: { mark: "?", color: "var(--c-conjecture, #ff9f80)" },
  claim: { mark: "!", color: "var(--c-claim, #b8c0ff)" },
  remark: { mark: "R", color: "var(--c-remark, #9ccfd8)" },
  notation: { mark: "N", color: "var(--c-notation, #7dcfff)" },
  observation: { mark: "O", color: "var(--c-observation, #a6da95)" },
  exercise: { mark: "E", color: "var(--c-exercise, #c099ff)" },
  solution: { mark: "S", color: "var(--c-solution, #8bd5ca)" },
  algorithm: { mark: "↳", color: "var(--c-algorithm, #73daca)" },
  question: { mark: "?", color: "var(--c-question, #f5bde6)" },
  attention: { mark: "!", color: "var(--c-attend, #ff8fa3)" },
  warning: { mark: "!", color: "var(--c-warning, #ffb86b)" },
  note: { mark: "·", color: "var(--c-note, #86f6e4)" },
  info: { mark: "i", color: "var(--c-info, #64d2ff)" },
  summary: { mark: "§", color: "var(--c-summary, #c6a0f6)" },
  fold: { mark: "›", color: "var(--c-fold, #b7c6e8)" },
  comment: { mark: "#", color: "var(--c-comment, #f2a272)" },
};

function floatingTocFoldKeys(headings: readonly MarkdownHeading[]): string[] {
  const counts = new Map<string, number>();
  const stack: Array<{ level: number; ordinal: number }> = [];
  return headings.map((heading) => {
    while (stack.length > 0 && heading.level <= stack[stack.length - 1]!.level) {
      stack.pop();
    }
    const parentPath = stack.map((part) => part.ordinal).join(".");
    const siblingGroup = `${parentPath}|${heading.level}`;
    const ordinal = (counts.get(siblingGroup) ?? 0) + 1;
    counts.set(siblingGroup, ordinal);
    const path = parentPath ? `${parentPath}.${ordinal}` : String(ordinal);
    stack.push({ level: heading.level, ordinal });
    return `${path}:${heading.level}:${heading.text}`;
  });
}

function floatingTocSignature(headings: readonly MarkdownHeading[]): string {
  const keys = floatingTocFoldKeys(headings);
  return headings
    .map((heading, index) => `${keys[index]}\t${heading.level}\t${heading.text}\t${heading.source || "markdown"}\t${heading.kind || ""}\t${heading.omit ? 1 : 0}`)
    .join("\n");
}

export function createFloatingTocPanel(options: {
  toc: HTMLElement;
  toggleButton: HTMLButtonElement;
  list: HTMLElement;
  editor: Editor;
  getNotes: () => NoteSummary[];
  getCurrentFile: () => string;
  resolveNoteRef: (ref: string) => NoteSummary | undefined;
  openNote: (note: NoteSummary, options?: OpenNoteOptions) => void;
  openTag?: (tag: string) => void;
}): FloatingTocPanel {
  let renderKey = "";
  const floatingFoldState = new Set<string>();
  let headingDoc: unknown = null;
  let headingCache: {
    items: MarkdownHeading[];
    signature: string;
  } = { items: [], signature: "" };
  let anchorDoc: unknown = null;
  let anchorCache: {
    items: InlineTagAnchor[];
    signature: string;
  } = { items: [], signature: "" };
  let orgEnvDoc: unknown = null;
  let orgEnvCache: { items: OrgEnvAnchor[]; signature: string } = { items: [], signature: "" };
  let orgEnvActive = false;

  const resizeHandle = document.createElement("div");
  resizeHandle.className = "aaronnote-toc-resize-handle";
  resizeHandle.title = "Resize TOC";
  resizeHandle.setAttribute("aria-hidden", "true");
  resizeHandle.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    const start = options.toc.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    resizeHandle.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent): void => {
      const maxWidth = Math.max(280, window.innerWidth - 28);
      const maxHeight = Math.max(180, window.innerHeight - 58);
      const width = Math.min(maxWidth, Math.max(260, start.width + startX - moveEvent.clientX));
      const height = Math.min(maxHeight, Math.max(160, start.height + moveEvent.clientY - startY));
      options.toc.style.width = `${Math.round(width)}px`;
      options.toc.style.height = `${Math.round(height)}px`;
    };
    const stop = (): void => {
      resizeHandle.removeEventListener("pointermove", move);
      resizeHandle.removeEventListener("pointerup", stop);
      resizeHandle.removeEventListener("pointercancel", stop);
    };
    resizeHandle.addEventListener("pointermove", move);
    resizeHandle.addEventListener("pointerup", stop);
    resizeHandle.addEventListener("pointercancel", stop);
  });
  options.toc.appendChild(resizeHandle);

  // Heading filter (TOC search). Persisted across re-renders; the input lives above
  // the list so `replaceChildren` on the list never destroys it.
  let filterQuery = "";
  const searchInput = document.createElement("input");
  searchInput.type = "search";
  searchInput.className = "aaronnote-toc-search";
  searchInput.placeholder = "Filter headings…";
  searchInput.setAttribute("aria-label", "Filter table of contents");
  searchInput.addEventListener("input", () => {
    filterQuery = searchInput.value.trim().toLowerCase();
    renderKey = "";
    update();
  });
  searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      if (searchInput.value) {
        searchInput.value = "";
        filterQuery = "";
        renderKey = "";
        update();
      } else {
        options.editor.focus();
      }
    }
  });
  if (options.list.parentElement) options.list.parentElement.insertBefore(searchInput, options.list);

  const orgEnvToggle = document.createElement("button");
  orgEnvToggle.type = "button";
  orgEnvToggle.className = "aaronnote-toc-org-toggle";
  orgEnvToggle.textContent = "Org blocks ▶";
  orgEnvToggle.setAttribute("aria-expanded", "false");
  orgEnvToggle.addEventListener("click", () => {
    orgEnvActive = !orgEnvActive;
    orgEnvToggle.textContent = orgEnvActive ? "Org blocks ▼" : "Org blocks ▶";
    orgEnvToggle.setAttribute("aria-expanded", orgEnvActive ? "true" : "false");
    renderKey = "";
    update();
  });
  if (options.list.parentElement) options.list.parentElement.insertBefore(orgEnvToggle, options.list);

  function editorHeadings(): {
    items: MarkdownHeading[];
    signature: string;
  } {
    const state = options.editor.view.state;
    if (state.doc === headingDoc) return headingCache;
    const index = tocIndexFromState(state);
    headingDoc = state.doc;
    headingCache = {
      items: index.headings,
      signature: index.headingSignature,
    };
    return headingCache;
  }

  function editorInlineAnchors(): {
    items: InlineTagAnchor[];
    signature: string;
  } {
    const state = options.editor.view.state;
    if (state.doc === anchorDoc) return anchorCache;
    const index = tocIndexFromState(state);
    anchorDoc = state.doc;
    anchorCache = {
      items: index.anchors,
      signature: index.anchorSignature,
    };
    return anchorCache;
  }

  function editorOrgEnvAnchors(): { items: OrgEnvAnchor[]; signature: string } {
    const doc = options.editor.view.state.doc;
    if (doc === orgEnvDoc) return orgEnvCache;
    const items = orgEnvAnchorsFromText(doc);
    orgEnvDoc = doc;
    orgEnvCache = {
      items,
      signature: items.map((item) => `${item.kind}\t${item.title}\t${item.pos}`).join("\n"),
    };
    return orgEnvCache;
  }

  function renderRelatedNotes(parent: DocumentFragment | HTMLElement, currentNote: NoteSummary | undefined): void {
    if (!currentNote) return;
    const notes = options.getNotes();
    const byId = new Map(notes.map((note) => [note.id, note]));
    const sections: Array<[string, string[]]> = [
      ["Links", currentNote.refs ?? []],
      ["Backlinks", currentNote.backlinks ?? []],
    ];
    for (const [label, ids] of sections) {
      const resolved = ids
        .map((id) => byId.get(id) || options.resolveNoteRef(id))
        .filter((note): note is NoteSummary => Boolean(note?.file));
      if (resolved.length === 0) continue;
      const head = document.createElement("div");
      head.className = "aaronnote-toc-section";
      head.textContent = label;
      parent.appendChild(head);
      for (const note of resolved) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "aaronnote-toc-item aaronnote-toc-related";
        button.style.setProperty("--toc-depth", "0");
        button.textContent = note.title || note.id || note.file || "Untitled";
        button.title = note.file || note.title || "";
        button.addEventListener("click", (event) => options.openNote(note, { newWindow: event.altKey || event.metaKey }));
        button.addEventListener("auxclick", (event) => {
          if (event.button !== 1) return;
          event.preventDefault();
          options.openNote(note, { newWindow: true });
        });
        parent.appendChild(button);
      }
    }
  }

  function renderCurrentTags(parent: DocumentFragment | HTMLElement, currentNote: NoteSummary | undefined): void {
    const tags = [...new Set((currentNote?.tags ?? []).map((tag) => String(tag).trim()).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b));
    if (tags.length === 0) return;
    const head = document.createElement("div");
    head.className = "aaronnote-toc-section";
    head.textContent = "Tags";
    parent.appendChild(head);
    for (const tag of tags) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "aaronnote-toc-item aaronnote-toc-tag";
      button.style.setProperty("--toc-depth", "0");
      button.textContent = `#${tag.replace(/^#/, "")}`;
      button.title = `tag:${tag.replace(/^#/, "")}`;
      button.addEventListener("click", () => options.openTag?.(tag.replace(/^#/, "")));
      parent.appendChild(button);
    }
  }

  function renderInlineAnchors(parent: DocumentFragment | HTMLElement, anchors: InlineTagAnchor[]): void {
    if (anchors.length === 0) return;
    const head = document.createElement("div");
    head.className = "aaronnote-toc-section";
    head.textContent = "Inline anchors";
    parent.appendChild(head);
    for (const anchor of anchors) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "aaronnote-toc-item aaronnote-toc-anchor";
      button.style.setProperty("--toc-depth", "0");
      button.textContent = `#${anchor.tag}`;
      button.title = `@@tag[${anchor.tag}]`;
      button.addEventListener("click", () => {
        options.editor.setSelection(anchor.pos, anchor.to);
        options.editor.focus();
      });
      parent.appendChild(button);
    }
  }

  function update(): void {
    // TOC indexing is demand-driven. While collapsed, document-change updates
    // stop here; opening the panel scans the current immutable CM6 document.
    if (options.toc.classList.contains("is-collapsed")) return;
    const notes = options.getNotes();
    const headingState = editorHeadings();
    const anchorState = editorInlineAnchors();
    const orgEnvState = orgEnvActive ? editorOrgEnvAnchors() : { items: [], signature: "" };
    const headings = headingState.items.filter((h) => !h.omit);
    const anchors = anchorState.items;
    const selectionPos = options.editor.view.state.selection.main.from;
    const activeIndex = headings.reduce((active, heading, index) => heading.pos <= selectionPos ? index : active, -1);
    const currentNote = notes.find((note) => note.file === options.getCurrentFile());
    const relatedIds = [...(currentNote?.refs ?? []), ...(currentNote?.backlinks ?? [])];
    const tags = currentNote?.tags ?? [];
    const foldRevision = [...floatingFoldState].sort().join(",");
    const headingRenderSignature = floatingTocSignature(headings);
    const key = `${activeIndex}\n${currentNote?.id ?? ""}\n${relatedIds.join(",")}\n${tags.join(",")}\n${headingRenderSignature}\n${anchorState.signature}\n${orgEnvState.signature}\n${foldRevision}\n${filterQuery}\n${orgEnvActive ? 1 : 0}`;
    if (key === renderKey) return;
    renderKey = key;

    const searching = filterQuery !== "";
    const matchText = (text: string): boolean => !searching || text.toLowerCase().includes(filterQuery);
    const frag = document.createDocumentFragment();
    const relatedCount = relatedIds.length;
    const tagCount = tags.length;
    const visibleAnchors = searching ? anchors.filter((a) => matchText(`#${a.tag}`)) : anchors;
    const anchorCount = visibleAnchors.length;
    const visibleOrgEnvs = orgEnvState.items.filter((item) =>
      !searching || matchText(`${item.kind} ${item.title}`),
    );
    const orgEnvCount = visibleOrgEnvs.length;
    options.toggleButton.textContent = headings.length > 0 ? `Page ${headings.length}` : "Page";

    const keys = floatingTocFoldKeys(headings);
    const headingHasChildren = headings.map((heading, index) => {
      const boundary = headings.slice(index + 1).find((next) => next.level <= heading.level)?.pos ?? Number.POSITIVE_INFINITY;
      const deeperHeading = index < headings.length - 1 && headings[index + 1]!.level > heading.level;
      const orgChild = orgEnvActive && orgEnvState.items.some((item) => item.pos > heading.pos && item.pos < boundary);
      return deeperHeading || orgChild;
    });

    const appendHeadingRow = (heading: MarkdownHeading, index: number, foldKey: string, withChevron: boolean): void => {
      const row = document.createElement("div");
      row.className = "aaronnote-toc-row";
      row.style.setProperty("--toc-depth", String(Math.max(0, heading.level - 1)));

      if (withChevron && headingHasChildren[index]) {
        const isFolded = floatingFoldState.has(foldKey);
        const chevron = document.createElement("button");
        chevron.type = "button";
        chevron.className = "aaronnote-toc-chevron";
        chevron.textContent = isFolded ? "▶" : "▼";
        chevron.title = isFolded ? "Expand" : "Collapse";
        chevron.addEventListener("click", (event) => {
          event.stopPropagation();
          if (floatingFoldState.has(foldKey)) floatingFoldState.delete(foldKey);
          else floatingFoldState.add(foldKey);
          renderKey = "";
          update();
        });
        row.appendChild(chevron);
      } else {
        // Reserve the chevron column so titles stay vertically aligned.
        const spacer = document.createElement("span");
        spacer.className = "aaronnote-toc-chevron-spacer";
        spacer.setAttribute("aria-hidden", "true");
        row.appendChild(spacer);
      }

      const button = document.createElement("button");
      button.type = "button";
      button.className = index === activeIndex ? "aaronnote-toc-item is-active" : "aaronnote-toc-item";
      button.dataset.level = String(heading.level);
      button.title = heading.text;
      if (index === activeIndex) button.setAttribute("aria-current", "location");
      button.textContent = heading.text;
      button.addEventListener("click", () => {
        const currentHeadings = editorHeadings().items.filter((item) => !item.omit);
        const currentKeys = floatingTocFoldKeys(currentHeadings);
        const currentHeading = currentHeadings[currentKeys.indexOf(foldKey)] ?? heading;
        options.editor.setSelection(currentHeading.pos);
        options.editor.focus();
      });
      row.appendChild(button);
      frag.appendChild(row);
    };

    const appendOrgEnvRow = (item: OrgEnvAnchor, depth: number): void => {
      const presentation = ORG_ENV_TOC_PRESENTATION[item.kind] ?? {
        mark: "•",
        color: "var(--c-env-default, #a7b0c4)",
      };
      const row = document.createElement("div");
      row.className = "aaronnote-toc-row aaronnote-toc-org-row";
      row.style.setProperty("--toc-depth", String(Math.max(0, depth)));
      row.style.setProperty("--toc-org-color", presentation.color);
      const marker = document.createElement("span");
      marker.className = "aaronnote-toc-org-marker";
      marker.textContent = presentation.mark;
      marker.title = item.kind;
      row.appendChild(marker);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "aaronnote-toc-item aaronnote-toc-org-env";
      button.dataset.kind = item.kind;
      button.textContent = item.title || item.kind;
      button.title = `#+begin ${item.kind}${item.title ? ` ${item.title}` : ""}`;
      button.addEventListener("click", () => {
        options.editor.setSelection(item.pos);
        options.editor.revealCursor();
        options.editor.focus();
      });
      row.appendChild(button);
      frag.appendChild(row);
    };

    let visibleHeadingCount = 0;
    let visibleOrgEnvCount = 0;
    if (searching) {
      const merged = [
        ...headings.map((heading, index) => ({ type: "heading" as const, pos: heading.pos, heading, index })),
        ...visibleOrgEnvs.map((item) => ({ type: "org" as const, pos: item.pos, item })),
      ].sort((a, b) => a.pos - b.pos);
      for (const entry of merged) {
        if (entry.type === "heading") {
          if (!matchText(entry.heading.text)) continue;
          visibleHeadingCount += 1;
          appendHeadingRow(entry.heading, entry.index, keys[entry.index]!, false);
        } else {
          visibleOrgEnvCount += 1;
          appendOrgEnvRow(entry.item, 0);
        }
      }
    } else {
      const merged = [
        ...headings.map((heading, index) => ({ type: "heading" as const, pos: heading.pos, heading, index })),
        ...visibleOrgEnvs.map((item) => ({ type: "org" as const, pos: item.pos, item })),
      ].sort((a, b) => a.pos - b.pos);
      const headingStack: Array<{ level: number; key: string }> = [];
      for (const entry of merged) {
        if (entry.type === "heading") {
          while (headingStack.length > 0 && entry.heading.level <= headingStack[headingStack.length - 1]!.level) {
            headingStack.pop();
          }
          const hidden = headingStack.some((parent) => floatingFoldState.has(parent.key));
          const foldKey = keys[entry.index]!;
          if (!hidden) {
            visibleHeadingCount += 1;
            appendHeadingRow(entry.heading, entry.index, foldKey, true);
          }
          headingStack.push({ level: entry.heading.level, key: foldKey });
        } else if (!headingStack.some((parent) => floatingFoldState.has(parent.key))) {
          visibleOrgEnvCount += 1;
          appendOrgEnvRow(entry.item, headingStack.at(-1)?.level ?? 0);
        }
      }
    }

    const hasAnyContent = headings.length > 0 || relatedCount > 0 || tagCount > 0 || anchors.length > 0 || orgEnvState.items.length > 0;
    if (!hasAnyContent) {
      const empty = document.createElement("div");
      empty.className = "aaronnote-toc-empty";
      empty.textContent = "No roam context";
      options.list.replaceChildren(empty);
      return;
    }
    if (searching && visibleHeadingCount === 0 && anchorCount === 0 && visibleOrgEnvCount === 0) {
      const empty = document.createElement("div");
      empty.className = "aaronnote-toc-empty";
      empty.textContent = "No matches";
      frag.appendChild(empty);
    }

    const status = document.createElement("div");
    status.className = "aaronnote-toc-status";
    status.textContent = searching
      ? `${visibleHeadingCount}/${headings.length} headings${anchorCount > 0 ? ` · ${anchorCount} anchors` : ""}`
      : [
        `${headings.length} headings`,
        orgEnvCount > 0 ? `${orgEnvCount} org blocks` : "",
        anchorCount > 0 ? `${anchorCount} anchors` : "",
        tagCount > 0 ? `${tagCount} tags` : "",
        relatedCount > 0 ? `${relatedCount} links` : "",
      ].filter(Boolean).join(" · ");
    frag.insertBefore(status, frag.firstChild);

    renderInlineAnchors(frag, visibleAnchors);
    renderCurrentTags(frag, currentNote);
    if (!searching) {
      renderRelatedNotes(frag, currentNote);
    }
    options.list.replaceChildren(frag);
  }

  function toggle(): void {
    options.toc.classList.toggle("is-collapsed");
    options.toggleButton.setAttribute("aria-expanded", options.toc.classList.contains("is-collapsed") ? "false" : "true");
    if (!options.toc.classList.contains("is-collapsed")) renderKey = "";
  }

  return { update, toggle };
}
