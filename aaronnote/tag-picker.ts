export type TagPickerOptions = {
  name: string;
  value?: string | readonly string[];
  suggestions?: string[];
  multiple?: boolean;
  allowCreate?: boolean;
  placeholder?: string;
  limit?: number;
};

export type TagPickerController = {
  root: HTMLElement;
  input: HTMLInputElement;
  search: HTMLInputElement;
  value(): string;
  tags(): string[];
  changes(): import("./note-tag-transaction.ts").TagChangeSet;
  focus(): void;
};

export type TagSuggestionSource = {
  tags?: readonly unknown[];
  inlineTags?: readonly unknown[];
};

type TagPickerChoice = {
  kind: "create" | "suggestion";
  tag: string;
};

import {
  cleanTagLabel,
  parseTagListText,
  stableTagList,
  tagChangesBetween,
  tagIdentity,
} from "./note-tag-transaction.ts";

export function parseTagPickerValue(value: unknown): string[] {
  return Array.isArray(value) ? stableTagList(value) : parseTagListText(value);
}

export function normalizeCreatedTag(value: unknown): string {
  return String(value || "")
    .trim()
    .replace(/^#+/, "")
    .replace(/[\s,]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function filterTagSuggestions(
  suggestions: string[],
  query = "",
  selected: string[] = [],
  limit = 40,
): string[] {
  const selectedKeys = new Set(selected.map(tagIdentity));
  const cleanQuery = normalizeCreatedTag(query).toLocaleLowerCase();
  const unique = new Map<string, string>();
  for (const suggestion of suggestions) {
    const tag = cleanTagLabel(suggestion);
    const key = tagIdentity(tag);
    if (!tag || selectedKeys.has(key) || unique.has(key)) continue;
    unique.set(key, tag);
  }
  return [...unique.values()]
    .filter((tag) => !cleanQuery || tag.toLocaleLowerCase().includes(cleanQuery))
    .sort((left, right) => {
      const a = left.toLocaleLowerCase();
      const b = right.toLocaleLowerCase();
      const aPrefix = cleanQuery && a.startsWith(cleanQuery) ? 0 : 1;
      const bPrefix = cleanQuery && b.startsWith(cleanQuery) ? 0 : 1;
      return aPrefix - bPrefix || a.localeCompare(b);
    })
    .slice(0, Math.max(1, limit));
}

/**
 * Tags remain database metadata even when a note is hidden from the knowledge
 * graph. Wiki notes also deliberately omit the legacy `roam` boolean. Do not
 * use graph visibility as an autocomplete/index visibility predicate here.
 */
export function collectTagSuggestions(notes: readonly TagSuggestionSource[]): string[] {
  const tags = new Map<string, string>();
  for (const note of notes) {
    for (const raw of [...(note.tags || []), ...(note.inlineTags || [])]) {
      const tag = String(raw || "").trim().replace(/^#/, "");
      if (!tag) continue;
      const key = tagIdentity(tag);
      if (!tags.has(key)) tags.set(key, tag);
    }
  }
  return [...tags.values()].sort((a, b) => a.localeCompare(b));
}

export function createTagPicker(options: TagPickerOptions): TagPickerController {
  const multiple = options.multiple !== false;
  const allowCreate = options.allowCreate ?? multiple;
  const suggestions = parseTagPickerValue((options.suggestions || []).join(","));
  let selected = parseTagPickerValue(options.value);
  const initial = [...selected];
  let focusedIndex = 0;

  const root = document.createElement("div");
  root.className = "aaronnote-tag-picker";
  const input = document.createElement("input");
  input.type = "hidden";
  input.name = options.name;
  const selectedEl = document.createElement("div");
  selectedEl.className = "aaronnote-tag-picker-selected";
  const search = document.createElement("input");
  search.type = "search";
  search.className = "aaronnote-tag-picker-search";
  search.placeholder = options.placeholder || (multiple ? "Type to filter or create a tag…" : "Type to filter tags…");
  search.autocomplete = "off";
  search.spellcheck = false;
  search.setAttribute("role", "combobox");
  search.setAttribute("aria-autocomplete", "list");
  search.setAttribute("aria-expanded", "true");
  const choices = document.createElement("div");
  choices.className = "aaronnote-tag-picker-options";
  choices.setAttribute("role", "listbox");
  choices.id = `aaronnote-tag-picker-${Math.random().toString(36).slice(2)}`;
  search.setAttribute("aria-controls", choices.id);
  const status = document.createElement("small");
  status.className = "aaronnote-tag-picker-status";
  status.setAttribute("aria-live", "polite");
  root.append(input, selectedEl, search, choices, status);

  const syncValue = (): void => {
    input.value = multiple ? selected.join(", ") : String(search.value || "").trim().replace(/^#/, "");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };

  const add = (raw: string): void => {
    const tag = normalizeCreatedTag(raw);
    if (!tag) return;
    if (multiple) {
      if (!selected.some((item) => tagIdentity(item) === tagIdentity(tag))) selected.push(tag);
      search.value = "";
    } else {
      selected = [tag];
      search.value = tag;
    }
    focusedIndex = 0;
    syncValue();
    render();
  };

  const remove = (tag: string): void => {
    selected = selected.filter((item) => tagIdentity(item) !== tagIdentity(tag));
    syncValue();
    render();
    search.focus();
  };

  const visibleSuggestions = (): string[] => filterTagSuggestions(
    suggestions,
    search.value,
    multiple ? selected : [],
    options.limit ?? 40,
  );

  const visibleChoices = (): TagPickerChoice[] => {
    const query = normalizeCreatedTag(search.value);
    const visible = visibleSuggestions();
    const exact = suggestions.some((tag) => tagIdentity(tag) === tagIdentity(query));
    return [
      ...(allowCreate && query && !exact ? [{ kind: "create" as const, tag: query }] : []),
      ...visible.map((tag) => ({ kind: "suggestion" as const, tag })),
    ];
  };

  const render = (): void => {
    selectedEl.replaceChildren();
    selectedEl.hidden = !multiple || selected.length === 0;
    if (multiple) {
      for (const tag of selected) {
        const chip = document.createElement("span");
        chip.className = "aaronnote-tag-picker-chip";
        const chipLabel = document.createElement("span");
        chipLabel.className = "aaronnote-tag-picker-chip-label";
        chipLabel.textContent = `#${tag}`;
        const removeButton = document.createElement("button");
        removeButton.type = "button";
        removeButton.className = "aaronnote-tag-picker-chip-remove";
        removeButton.textContent = "×";
        removeButton.setAttribute("aria-label", `Remove tag ${tag}`);
        removeButton.addEventListener("click", () => remove(tag));
        chip.append(chipLabel, removeButton);
        selectedEl.appendChild(chip);
      }
    }

    const visible = visibleSuggestions();
    const options = visibleChoices();
    focusedIndex = Math.max(0, Math.min(focusedIndex, Math.max(0, options.length - 1)));
    choices.replaceChildren();
    const query = normalizeCreatedTag(search.value);
    options.forEach((option, index) => {
      const choice = document.createElement("button");
      choice.type = "button";
      choice.className = "aaronnote-tag-picker-option";
      choice.classList.toggle("is-create", option.kind === "create");
      if (option.kind === "suggestion") choice.dataset.tag = option.tag;
      else choice.dataset.createTag = option.tag;
      choice.textContent = option.kind === "create" ? `Create #${option.tag}` : `#${option.tag}`;
      choice.setAttribute("role", "option");
      choice.setAttribute("aria-selected", String(index === focusedIndex));
      choice.classList.toggle("is-focused", index === focusedIndex);
      choice.addEventListener("mousedown", (event) => event.preventDefault());
      choice.addEventListener("click", () => {
        add(option.tag);
        search.focus();
      });
      choices.appendChild(choice);
    });
    status.textContent = visible.length
      ? `${visible.length} matching tag${visible.length === 1 ? "" : "s"}`
      : query && allowCreate ? `Press Enter to create #${query}` : "No matching tags";
  };

  search.addEventListener("input", () => {
    focusedIndex = 0;
    if (!multiple) syncValue();
    render();
  });
  search.addEventListener("keydown", (event) => {
    const options = visibleChoices();
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (options.length) {
        const delta = event.key === "ArrowDown" ? 1 : -1;
        focusedIndex = (focusedIndex + delta + options.length) % options.length;
        render();
        choices.querySelector<HTMLElement>(".is-focused")?.scrollIntoView({ block: "nearest" });
      }
      return;
    }
    if (event.key === "Enter" && options.length) {
      event.preventDefault();
      add(options[focusedIndex]?.tag || "");
      return;
    }
    if (multiple && event.key === "," && search.value.trim()) {
      event.preventDefault();
      add(search.value);
      return;
    }
    if (event.key === "Escape" && search.value) {
      event.preventDefault();
      event.stopPropagation();
      search.value = "";
      if (!multiple) syncValue();
      render();
    }
  });

  if (!multiple) search.value = selected[0] || "";
  syncValue();
  render();
  return {
    root,
    input,
    search,
    value: () => input.value,
    tags: () => [...selected],
    changes: () => tagChangesBetween(initial, selected),
    focus: () => search.focus(),
  };
}
