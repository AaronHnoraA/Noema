import type { NoteSummary } from "./types.ts";

export type KnowledgeDockView = "backlinks" | "graph" | "search" | "tags";

export type KnowledgeBacklink = {
  key: string;
  ref: string;
  title: string;
  detail: string;
  summary: string;
  tags: string[];
  note?: NoteSummary;
};

export type KnowledgeTagItem = {
  name: string;
  count: number;
  current?: boolean;
};

export type DesktopKnowledgeDock = {
  activeView: () => KnowledgeDockView;
  collapse: () => void;
  destroy: () => void;
  refresh: () => void;
  show: (view: KnowledgeDockView, options?: { focus?: boolean }) => void;
  toggle: (view: KnowledgeDockView) => void;
};

type DesktopKnowledgeDockOptions = {
  root: HTMLElement;
  body: HTMLElement;
  visibilityButton: HTMLButtonElement;
  tabButtons: HTMLButtonElement[];
  panes: Record<KnowledgeDockView, HTMLElement>;
  backlinkList: HTMLElement;
  backlinkStatus: HTMLElement;
  tagList: HTMLElement;
  tagStatus: HTMLElement;
  searchInput: HTMLInputElement;
  getCurrentNote: () => NoteSummary | undefined;
  resolveNoteRef: (ref: string) => NoteSummary | undefined;
  relationshipSource?: () => string;
  openNote: (note: NoteSummary, options?: { newWindow?: boolean }) => void;
  getTags: () => KnowledgeTagItem[];
  openTag: (tag: string) => void;
  onStateChange?: (view: KnowledgeDockView, expanded: boolean) => void;
  onGraphVisible: () => void;
  onGraphHidden: () => void;
  onCollapse: () => void;
};

function noteKey(note: NoteSummary | undefined): string {
  return String(note?.key || note?.id || note?.file || note?.path || note?.title || "").trim();
}

function backlinkDetail(note: NoteSummary): string {
  return String(note.path || note.link || note.file || note.id || "").trim();
}

export function projectKnowledgeBacklinks(
  current: NoteSummary | undefined,
  resolveNoteRef: (ref: string) => NoteSummary | undefined,
): KnowledgeBacklink[] {
  const seen = new Set<string>();
  const entries: KnowledgeBacklink[] = [];
  for (const value of current?.backlinks ?? []) {
    const ref = String(value || "").trim();
    if (!ref) continue;
    const note = resolveNoteRef(ref);
    const key = noteKey(note) || `missing:${ref.toLocaleLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({
      key,
      ref,
      title: String(note?.title || note?.id || ref || "Untitled"),
      detail: note ? backlinkDetail(note) : ref,
      summary: String(note?.summary || "").trim(),
      tags: (note?.tags ?? []).map((tag) => String(tag || "").trim()).filter(Boolean).slice(0, 4),
      note,
    });
  }
  return entries;
}

export function createDesktopKnowledgeDock(options: DesktopKnowledgeDockOptions): DesktopKnowledgeDock {
  let view: KnowledgeDockView = "backlinks";
  let destroyed = false;

  const expanded = (): boolean => !options.root.classList.contains("is-collapsed");

  const setExpanded = (next: boolean): void => {
    options.root.classList.toggle("is-collapsed", !next);
    options.body.classList.toggle("noema-knowledge-dock-open", next);
    options.visibilityButton.setAttribute("aria-expanded", String(next));
    options.onStateChange?.(view, next);
  };

  const renderBacklinks = (): void => {
    const current = options.getCurrentNote();
    const entries = projectKnowledgeBacklinks(current, options.resolveNoteRef);
    options.backlinkList.replaceChildren();
    const source = options.relationshipSource?.() === "kernel-refs" ? " · kernel refs" : "";
    if (!current) {
      options.backlinkStatus.textContent = "Open a note to inspect backlinks";
      return;
    }
    options.backlinkStatus.textContent = `${entries.length} backlink${entries.length === 1 ? "" : "s"}${source}`;
    if (!entries.length) {
      const empty = document.createElement("p");
      empty.className = "noema-knowledge-dock-empty";
      empty.textContent = "No indexed pages link to this note yet.";
      options.backlinkList.appendChild(empty);
      return;
    }
    for (const entry of entries) {
      const item = document.createElement(entry.note ? "button" : "div");
      item.className = "noema-knowledge-backlink";
      if (item instanceof HTMLButtonElement) {
        item.type = "button";
        item.addEventListener("click", (event) => {
          if (!entry.note) return;
          options.openNote(entry.note, { newWindow: event.metaKey || event.ctrlKey || event.altKey });
        });
      } else {
        item.classList.add("is-unresolved");
      }
      const title = document.createElement("strong");
      title.textContent = entry.title;
      const detail = document.createElement("small");
      detail.textContent = entry.detail;
      item.append(title, detail);
      if (entry.summary) {
        const summary = document.createElement("span");
        summary.textContent = entry.summary;
        item.appendChild(summary);
      }
      if (entry.tags.length) {
        const tags = document.createElement("span");
        tags.className = "noema-knowledge-backlink-tags";
        tags.textContent = entry.tags.map((tag) => `#${tag.replace(/^#/, "")}`).join(" ");
        item.appendChild(tags);
      }
      options.backlinkList.appendChild(item);
    }
  };

  const renderTags = (): void => {
    const tags = options.getTags();
    const current = tags.filter((tag) => tag.current);
    const workspace = tags.filter((tag) => !tag.current);
    options.tagList.replaceChildren();
    options.tagStatus.textContent = `${current.length} current · ${tags.length} workspace tag${tags.length === 1 ? "" : "s"}`;
    if (!tags.length) {
      const empty = document.createElement("p");
      empty.className = "noema-knowledge-dock-empty";
      empty.textContent = "No portable tags are indexed yet.";
      options.tagList.appendChild(empty);
      return;
    }
    const appendGroup = (label: string, items: KnowledgeTagItem[]): void => {
      if (!items.length) return;
      const heading = document.createElement("strong");
      heading.className = "noema-knowledge-tag-heading";
      heading.textContent = label;
      options.tagList.appendChild(heading);
      for (const item of items) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `noema-knowledge-tag${item.current ? " is-current" : ""}`;
        const name = document.createElement("span");
        name.textContent = `#${item.name.replace(/^#/, "")}`;
        const count = document.createElement("small");
        count.textContent = String(item.count);
        button.append(name, count);
        button.addEventListener("click", () => options.openTag(item.name));
        options.tagList.appendChild(button);
      }
    };
    appendGroup("Current note", current);
    appendGroup(current.length ? "Workspace" : "All tags", workspace);
  };

  const renderActiveView = (): void => {
    if (view === "backlinks") renderBacklinks();
    else if (view === "tags") renderTags();
  };

  const select = (next: KnowledgeDockView, focus: boolean): void => {
    const previous = view;
    view = next;
    options.root.dataset.knowledgeView = next;
    for (const [name, pane] of Object.entries(options.panes) as Array<[KnowledgeDockView, HTMLElement]>) {
      pane.hidden = name !== next;
    }
    for (const button of options.tabButtons) {
      const selected = button.dataset.knowledgeView === next;
      button.classList.toggle("is-active", selected);
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
    }
    if (previous === "search" && next !== "search") options.searchInput.blur();
    if (previous === "graph" && next !== "graph") options.onGraphHidden();
    renderActiveView();
    if (expanded()) options.onStateChange?.(view, true);
    if (next === "search" && focus) queueMicrotask(() => {
      if (!destroyed && expanded() && view === "search") {
        options.searchInput.focus();
        options.searchInput.select();
      }
    });
  };

  const show = (next: KnowledgeDockView, showOptions: { focus?: boolean } = {}): void => {
    if (destroyed) return;
    const wasExpanded = expanded();
    select(next, showOptions.focus !== false);
    if (!wasExpanded) setExpanded(true);
    if (next === "graph") options.onGraphVisible();
  };

  const collapse = (): void => {
    if (destroyed || !expanded()) return;
    if (view === "search") options.searchInput.blur();
    options.onCollapse();
    setExpanded(false);
  };

  const toggle = (next: KnowledgeDockView): void => {
    if (expanded() && view === next) collapse();
    else show(next);
  };

  const onTabClick = (event: Event): void => {
    const button = event.currentTarget as HTMLButtonElement;
    const next = button.dataset.knowledgeView as KnowledgeDockView | undefined;
    if (next && next in options.panes) show(next);
  };
  for (const button of options.tabButtons) button.addEventListener("click", onTabClick);

  select(view, false);
  setExpanded(expanded());

  return {
    activeView: () => view,
    collapse,
    refresh: renderActiveView,
    show,
    toggle,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      options.onCollapse();
      setExpanded(false);
      for (const button of options.tabButtons) button.removeEventListener("click", onTabClick);
    },
  };
}
