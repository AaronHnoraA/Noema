import type { WikiNote, WikiSearchResult } from "./api-client.ts";

export type KnowledgeSearchController = { refresh: () => void; close: () => void; destroy: () => void };

export function createKnowledgeSearch(options: {
  input: HTMLInputElement;
  anchor: HTMLElement;
  search: (body: Record<string, unknown>) => Promise<WikiSearchResult>;
  open: (note: WikiNote, options?: { newWindow?: boolean }) => void;
  context?: () => Record<string, string>;
  limit?: number;
}): KnowledgeSearchController {
  const popup = document.createElement("div");
  popup.className = "noema-knowledge-search-results";
  popup.setAttribute("role", "listbox");
  popup.hidden = true;
  options.anchor.appendChild(popup);
  let timer = 0;
  let sequence = 0;
  let items: WikiNote[] = [];
  let active = 0;

  const close = (): void => { popup.hidden = true; options.input.setAttribute("aria-expanded", "false"); };
  const openItem = (note: WikiNote, newWindow = false): void => {
    close();
    options.open(note, { newWindow });
  };
  const render = (result: WikiSearchResult): void => {
    items = result.items.slice(0, options.limit || 8);
    active = Math.min(active, Math.max(0, items.length - 1));
    popup.replaceChildren();
    if (!items.length) {
      const empty = document.createElement("p");
      empty.textContent = options.input.value.trim() ? "No matching pages" : "No related pages yet";
      popup.appendChild(empty);
    }
    items.forEach((note, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(index === active));
      const title = document.createElement("strong");
      title.textContent = note.title || note.id || "Untitled";
      const meta = document.createElement("small");
      meta.textContent = [note.qualifiedNamespace || note.namespace, note.repositoryId, ...(note.tags || []).slice(0, 3).map((tag) => `#${tag}`)].filter(Boolean).join(" · ");
      button.append(title, meta);
      if (note.excerpt) {
        const excerpt = document.createElement("span");
        excerpt.textContent = note.excerpt.replaceAll("[[", "").replaceAll("]]", "");
        button.appendChild(excerpt);
      } else if (note.reasons?.length) {
        const reason = document.createElement("span");
        reason.textContent = note.reasons.join(" · ");
        button.appendChild(reason);
      }
      button.addEventListener("mouseenter", () => {
        active = index;
        popup.querySelectorAll<HTMLElement>("[role='option']").forEach((item, itemIndex) => item.setAttribute("aria-selected", String(itemIndex === active)));
      });
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", (event) => openItem(note, event.metaKey || event.altKey));
      popup.appendChild(button);
    });
    popup.hidden = false;
    options.input.setAttribute("aria-expanded", "true");
  };
  const refresh = (): void => {
    window.clearTimeout(timer);
    const run = ++sequence;
    timer = window.setTimeout(() => {
      const query = options.input.value.trim();
      void options.search({
        query,
        mode: query ? "suggest" : "suggest",
        context: options.context?.() || {},
        limit: options.limit || 8,
      }).then((result) => { if (run === sequence && document.activeElement === options.input) render(result); })
        .catch(() => { if (run === sequence) close(); });
    }, options.input.value.trim() ? 120 : 0);
  };
  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!items.length) return;
      event.preventDefault();
      active = (active + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      popup.querySelectorAll<HTMLElement>("[role='option']").forEach((item, index) => item.setAttribute("aria-selected", String(index === active)));
      popup.querySelector<HTMLElement>(`[role='option']:nth-child(${active + 1})`)?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter" && items[active]) {
      event.preventDefault();
      openItem(items[active], event.metaKey || event.altKey);
    } else if (event.key === "Escape") {
      event.preventDefault();
      if (options.input.value) { options.input.value = ""; refresh(); } else { close(); options.input.blur(); }
    }
  };
  const onBlur = (): void => { window.setTimeout(close, 120); };
  options.input.setAttribute("role", "combobox");
  options.input.setAttribute("aria-autocomplete", "list");
  options.input.setAttribute("aria-expanded", "false");
  options.input.addEventListener("input", refresh);
  options.input.addEventListener("focus", refresh);
  options.input.addEventListener("keydown", onKeydown);
  options.input.addEventListener("blur", onBlur);
  return {
    refresh,
    close,
    destroy() {
      window.clearTimeout(timer);
      sequence += 1;
      options.input.removeEventListener("input", refresh);
      options.input.removeEventListener("focus", refresh);
      options.input.removeEventListener("keydown", onKeydown);
      options.input.removeEventListener("blur", onBlur);
      popup.remove();
    },
  };
}
