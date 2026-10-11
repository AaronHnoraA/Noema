// The reference picker: one popup for linking to a page, a heading, a tag or
// a citation.  It shows what the kernel answers (kernel/noema/wikisearch,
// mode "references") and inserts the text the kernel wrote for the chosen
// item.  It matches nothing itself and knows no link syntax.

export type ReferenceItem = {
  kind: "page" | "heading" | "anchor" | "block" | "file" | "cite" | "create";
  label: string;
  detail?: string;
  group?: string;
  insert: string;
  /** The destination alone, for a link whose brackets are already typed. */
  target?: string;
  pageId?: string;
  title?: string;
  file?: string;
  fragment?: string;
  line?: number;
  level?: number;
  matchKind?: string;
  titleRanges?: Array<[number, number]>;
  /** Where the display text sits inside `insert`; select it after inserting. */
  labelRange?: [number, number];
};

export type ReferenceAnswer = {
  ok?: boolean;
  items?: ReferenceItem[];
  explain?: string[];
  scope?: string;
};

export type ReferencePickerOptions = {
  /** Ask the kernel.  QUERY is the input as typed. */
  lookup: (query: string) => Promise<ReferenceAnswer>;
  /**
   * Put ITEM into the note.  CONTEXT is what `open` was given: where the
   * lookup was started from, when it was started by typing in the note.
   */
  insert: (item: ReferenceItem, context: unknown) => void;
  /** Where the popup opens: the caret, in viewport coordinates. */
  anchor: () => { left: number; top: number; bottom: number } | null;
  /** Called when the popup closes; CHOSEN says an item was picked. */
  closed?: (chosen: boolean, context: unknown) => void;
  delayMs?: number;
};

export type ReferencePicker = {
  open: (initial?: string, context?: unknown) => void;
  close: () => void;
  isOpen: () => boolean;
  destroy: () => void;
};

/** What the first character of the input asks for, shown under the field. */
// The prefixes are roam's own: "#" before a tag, "@" before a heading path.
export const REFERENCE_SCOPES: ReadonlyArray<{ prefix: string; label: string }> = [
  { prefix: "", label: "this page, then pages" },
  { prefix: "#", label: "tags" },
  { prefix: "@", label: "headings" },
  { prefix: "Page# Page@", label: "inside a page" },
  { prefix: "@@", label: "citations" },
  { prefix: "/", label: "files" },
];

/**
 * The query that looks inside ITEM's page, for Tab on a page row.  The page
 * is named by its id, which no other page shares, and "@" asks for its
 * headings; typing "#" instead of it asks for its tags.
 */
export function drillQuery(item: ReferenceItem): string | null {
  if (item.kind !== "page") return null;
  const name = item.pageId || item.title;
  return name ? `${name}@` : null;
}

/** LABEL as DOM nodes, the runes in RANGES marked. */
export function renderMatchedLabel(label: string, ranges: ReadonlyArray<readonly [number, number]> = []): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const runes = [...label];
  let at = 0;
  for (const [from, to] of [...ranges].sort((a, b) => a[0] - b[0])) {
    if (from < at || to > runes.length || from >= to) continue;
    if (from > at) fragment.append(runes.slice(at, from).join(""));
    const mark = document.createElement("mark");
    mark.textContent = runes.slice(from, to).join("");
    fragment.append(mark);
    at = to;
  }
  if (at < runes.length) fragment.append(runes.slice(at).join(""));
  return fragment;
}

const KIND_GLYPH: Record<ReferenceItem["kind"], string> = {
  page: "◆", heading: "§", anchor: "#", block: "▣", file: "▤", cite: "❝", create: "+",
};

export function createReferencePicker(options: ReferencePickerOptions): ReferencePicker {
  const root = document.createElement("div");
  root.className = "noema-reference-picker";
  root.hidden = true;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "Insert a reference");
  const input = document.createElement("input");
  input.type = "text";
  input.spellcheck = false;
  input.autocomplete = "off";
  input.placeholder = "Link to…   #tag   @heading   Page@heading   @@citation   /file";
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  const list = document.createElement("div");
  list.className = "noema-reference-picker-list";
  list.setAttribute("role", "listbox");
  const hint = document.createElement("p");
  hint.className = "noema-reference-picker-hint";
  root.append(input, list, hint);
  document.body.appendChild(root);

  let items: ReferenceItem[] = [];
  let context: unknown;
  let active = 0;
  let sequence = 0;
  let timer = 0;

  const select = (index: number): void => {
    active = Math.max(0, Math.min(index, items.length - 1));
    list.querySelectorAll<HTMLElement>("[role='option']").forEach((row, rowIndex) => {
      row.setAttribute("aria-selected", String(rowIndex === active));
      if (rowIndex === active) row.scrollIntoView({ block: "nearest" });
    });
  };

  const render = (answer: ReferenceAnswer): void => {
    items = answer.items || [];
    active = 0;
    list.replaceChildren();
    let group = "";
    items.forEach((item, index) => {
      if ((item.group || "") !== group) {
        group = item.group || "";
        const heading = document.createElement("h4");
        heading.textContent = group;
        list.appendChild(heading);
      }
      const row = document.createElement("button");
      row.type = "button";
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(index === 0));
      row.dataset.kind = item.kind;
      const glyph = document.createElement("i");
      glyph.textContent = KIND_GLYPH[item.kind] || "·";
      const label = document.createElement("strong");
      if (item.kind === "heading" && item.level && item.level > 1) label.style.paddingLeft = `${(item.level - 1) * 10}px`;
      label.append(renderMatchedLabel(item.label, item.titleRanges));
      const detail = document.createElement("small");
      detail.textContent = item.detail || "";
      row.append(glyph, label, detail);
      row.addEventListener("mousedown", (event) => event.preventDefault());
      row.addEventListener("mouseenter", () => select(index));
      row.addEventListener("click", () => choose(index));
      list.appendChild(row);
    });
    if (!items.length) {
      const empty = document.createElement("p");
      empty.textContent = answer.ok === false ? "Noema's kernel is not answering." : "Nothing to link to.";
      list.appendChild(empty);
    }
    hint.textContent = (answer.explain || []).join(" · ")
      || REFERENCE_SCOPES.map((scope) => (scope.prefix ? `${scope.prefix} ${scope.label}` : scope.label)).join("   ");
  };

  const refresh = (immediate = false): void => {
    window.clearTimeout(timer);
    const run = ++sequence;
    const query = input.value;
    timer = window.setTimeout(() => {
      options.lookup(query)
        .then((answer) => { if (run === sequence && !root.hidden) render(answer); })
        .catch(() => { if (run === sequence && !root.hidden) render({ ok: false, items: [] }); });
    }, immediate ? 0 : options.delayMs ?? 60);
  };

  const close = (chosen = false): void => {
    if (root.hidden) return;
    root.hidden = true;
    sequence += 1;
    window.clearTimeout(timer);
    options.closed?.(chosen, context);
  };

  function choose(index: number): void {
    const item = items[index];
    if (!item) return;
    const from = context;
    close(true);
    options.insert(item, from);
  }

  const place = (): void => {
    const rect = options.anchor();
    const width = Math.min(560, window.innerWidth - 24);
    root.style.width = `${width}px`;
    const left = Math.max(12, Math.min((rect?.left ?? window.innerWidth / 2 - width / 2), window.innerWidth - width - 12));
    root.style.left = `${left}px`;
    // Below the caret when there is room for a useful list, above otherwise.
    const below = rect ? window.innerHeight - rect.bottom : window.innerHeight;
    if (rect && below < 260 && rect.top > below) {
      root.style.top = "";
      root.style.bottom = `${window.innerHeight - rect.top + 6}px`;
    } else {
      root.style.bottom = "";
      root.style.top = `${(rect?.bottom ?? window.innerHeight * 0.18) + 6}px`;
    }
  };

  input.addEventListener("input", () => refresh());
  input.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    const key = event.key;
    if (key === "ArrowDown" || (event.ctrlKey && key === "n")) {
      event.preventDefault();
      select(active + 1);
    } else if (key === "ArrowUp" || (event.ctrlKey && key === "p")) {
      event.preventDefault();
      select(active - 1);
    } else if (key === "Enter") {
      event.preventDefault();
      choose(active);
    } else if (key === "Tab") {
      // Look inside the page on this row.
      event.preventDefault();
      const next = items[active] && drillQuery(items[active]);
      if (next) {
        input.value = next;
        refresh(true);
      }
    } else if (key === "Escape" || (event.ctrlKey && key === "g")) {
      event.preventDefault();
      close(false);
    } else {
      return;
    }
    event.stopPropagation();
  });
  input.addEventListener("blur", () => window.setTimeout(() => { if (document.activeElement !== input) close(false); }, 120));

  return {
    open(initial = "", openedFrom?: unknown) {
      context = openedFrom;
      input.value = initial;
      items = [];
      list.replaceChildren();
      root.hidden = false;
      place();
      input.focus();
      input.setSelectionRange(initial.length, initial.length);
      refresh(true);
    },
    close: () => close(false),
    isOpen: () => !root.hidden,
    destroy() {
      close(false);
      root.remove();
    },
  };
}
