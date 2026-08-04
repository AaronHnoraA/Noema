export type TagChangeSet = {
  add: string[];
  remove: string[];
};

export type MarkdownTagEdit = {
  changed: boolean;
  from: number;
  to: number;
  insert: string;
  tags: string[];
};

export type MarkdownMetadataChangeSet = {
  tags?: TagChangeSet;
  project?: string;
};

type ParsedTagEntry = {
  raw: string;
  value: string;
};

type MetadataBlock = {
  kind: "org" | "yaml";
  from: number;
  to: number;
  text: string;
};

type TagField = {
  from: number;
  to: number;
  entries: ParsedTagEntry[];
  render: (entries: ParsedTagEntry[]) => string;
};

export function cleanTagLabel(value: unknown): string {
  return String(value ?? "").normalize("NFKC").trim().replace(/^#+/, "");
}

export function tagIdentity(value: unknown): string {
  return cleanTagLabel(value).toLocaleLowerCase();
}

export function stableTagList(values: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const value of values) {
    const tag = cleanTagLabel(value);
    const key = tagIdentity(tag);
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  return tags;
}

function unquoteTag(raw: string): string {
  const text = String(raw || "").trim();
  const quote = text[0];
  if ((quote === "\"" || quote === "'") && text.at(-1) === quote) {
    return cleanTagLabel(text.slice(1, -1).replaceAll(`\\${quote}`, quote).replaceAll("\\\\", "\\"));
  }
  return cleanTagLabel(text);
}

function separatedTagEntries(rawValue: string): ParsedTagEntry[] {
  let value = String(rawValue || "").trim();
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
  const entries: ParsedTagEntry[] = [];
  let start = 0;
  let quote = "";
  let escaped = false;
  const commit = (end: number): void => {
    const raw = value.slice(start, end).trim();
    const tag = unquoteTag(raw);
    if (raw && tag) entries.push({ raw, value: tag });
  };
  for (let index = 0; index <= value.length; index += 1) {
    const character = value[index] || "";
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }
    if (index === value.length || character === "," || /\s/.test(character)) {
      commit(index);
      while (index + 1 < value.length && (value[index + 1] === "," || /\s/.test(value[index + 1] || ""))) index += 1;
      start = index + 1;
    }
  }
  return entries;
}

export function parseTagListText(value: unknown): string[] {
  return stableTagList(separatedTagEntries(String(value || "")).map((entry) => entry.value));
}

function metadataBlock(markdown: string): MetadataBlock | null {
  const text = String(markdown || "");
  const org = /^(?:\uFEFF)?[ \t]*#\+begin[ \t]+meta[ \t]*\r?\n[\s\S]*?^[ \t]*#\+end[ \t]+meta[ \t]*(?:\r?\n|$)/im.exec(text);
  if (org?.index === 0) return { kind: "org", from: 0, to: org[0].length, text: org[0] };
  const yaml = /^(?:\uFEFF)?[ \t]*---[ \t]*\r?\n[\s\S]*?^[ \t]*---[ \t]*(?:\r?\n|$)/m.exec(text);
  return yaml?.index === 0 ? { kind: "yaml", from: 0, to: yaml[0].length, text: yaml[0] } : null;
}

function tagField(block: MetadataBlock): TagField | null {
  const match = /^([ \t]*tags[ \t]*:)([^\r\n]*)(\r?\n|$)/im.exec(block.text);
  if (!match || match.index == null) return null;
  const from = block.from + match.index;
  const lineTo = from + match[0].length;
  const prefix = match[1] || "tags:";
  const rawValue = match[2] || "";
  const lineEnding = match[3] || (block.text.includes("\r\n") ? "\r\n" : "\n");
  if (rawValue.trim()) {
    const trimmed = rawValue.trim();
    const bracketed = trimmed.startsWith("[") && trimmed.endsWith("]");
    const entries = separatedTagEntries(trimmed);
    const leading = rawValue.match(/^[ \t]*/)?.[0] || " ";
    const separator = rawValue.match(/,[ \t]*/)?.[0] || " ";
    return {
      from,
      to: lineTo,
      entries,
      render(next) {
        const body = next.map((entry) => entry.raw).join(separator);
        return `${prefix}${next.length ? leading : ""}${bracketed ? `[${body}]` : body}${lineEnding}`;
      },
    };
  }

  const entries: ParsedTagEntry[] = [];
  let cursor = match.index + match[0].length;
  let itemPrefix = "  - ";
  while (cursor < block.text.length) {
    const item = /^([ \t]*-[ \t]+)([^\r\n]*)(\r?\n|$)/.exec(block.text.slice(cursor));
    if (!item) break;
    const raw = String(item[2] || "").trim();
    const value = unquoteTag(raw);
    if (!raw || !value) break;
    if (entries.length === 0) itemPrefix = item[1] || itemPrefix;
    entries.push({ raw, value });
    cursor += item[0].length;
  }
  const to = block.from + cursor;
  return {
    from,
    to,
    entries,
    render(next) {
      return `${prefix}${lineEnding}${next.map((entry) => `${itemPrefix}${entry.raw}${lineEnding}`).join("")}`;
    },
  };
}

function currentTagEntries(markdown: string): { block: MetadataBlock | null; field: TagField | null; entries: ParsedTagEntry[] } {
  const block = metadataBlock(markdown);
  const field = block ? tagField(block) : null;
  return { block, field, entries: field?.entries ?? [] };
}

export function metadataTagsFromMarkdown(markdown: unknown): string[] | null {
  const parsed = currentTagEntries(String(markdown || ""));
  return parsed.field ? stableTagList(parsed.entries.map((entry) => entry.value)) : null;
}

export function tagChangesBetween(initial: readonly unknown[], selected: readonly unknown[]): TagChangeSet {
  const before = stableTagList(initial);
  const after = stableTagList(selected);
  const beforeKeys = new Set(before.map(tagIdentity));
  const afterKeys = new Set(after.map(tagIdentity));
  return {
    add: after.filter((tag) => !beforeKeys.has(tagIdentity(tag))),
    remove: before.filter((tag) => !afterKeys.has(tagIdentity(tag))),
  };
}

function applyTagChanges(entries: ParsedTagEntry[], changes: TagChangeSet): ParsedTagEntry[] {
  const removed = new Set(stableTagList(changes.remove).map(tagIdentity));
  const next = entries.filter((entry) => !removed.has(tagIdentity(entry.value)));
  const present = new Set(next.map((entry) => tagIdentity(entry.value)));
  for (const tag of stableTagList(changes.add)) {
    const key = tagIdentity(tag);
    if (present.has(key)) continue;
    present.add(key);
    next.push({ raw: tag, value: tag });
  }
  return next;
}

function unchangedEntries(left: ParsedTagEntry[], right: ParsedTagEntry[]): boolean {
  return left.length === right.length && left.every((entry, index) => (
    entry.raw === right[index]?.raw && entry.value === right[index]?.value
  ));
}

function insertTagField(block: MetadataBlock, tags: ParsedTagEntry[]): MarkdownTagEdit {
  const lineEnding = block.text.includes("\r\n") ? "\r\n" : "\n";
  const closePattern = block.kind === "org" ? /^[ \t]*#\+end[ \t]+meta[ \t]*$/gim : /^[ \t]*---[ \t]*$/gm;
  const closes = [...block.text.matchAll(closePattern)];
  const close = closes.at(-1);
  if (!close || close.index == null) return { changed: false, from: 0, to: 0, insert: "", tags: [] };
  const from = block.from + close.index;
  const prefix = close.index > 0 && !/[\r\n]$/.test(block.text.slice(0, close.index)) ? lineEnding : "";
  const insert = `${prefix}tags: ${tags.map((entry) => entry.raw).join(", ")}${lineEnding}`;
  return { changed: true, from, to: from, insert, tags: stableTagList(tags.map((entry) => entry.value)) };
}

function applyTextEdit(markdown: string, edit: Pick<MarkdownTagEdit, "changed" | "from" | "to" | "insert">): string {
  return edit.changed ? `${markdown.slice(0, edit.from)}${edit.insert}${markdown.slice(edit.to)}` : markdown;
}

function cleanMetadataScalar(value: unknown): string {
  return String(value ?? "").replace(/[\r\n]+/g, " ").trim();
}

function planMetadataScalarChange(markdown: string, key: string, rawValue: unknown): Omit<MarkdownTagEdit, "tags"> {
  const value = cleanMetadataScalar(rawValue);
  const block = metadataBlock(markdown);
  if (!block) {
    if (!value) return { changed: false, from: 0, to: 0, insert: "" };
    const lineEnding = markdown.includes("\r\n") ? "\r\n" : "\n";
    return {
      changed: true,
      from: 0,
      to: 0,
      insert: `#+begin meta${lineEnding}${key}: ${value}${lineEnding}#+end meta${lineEnding}${lineEnding}`,
    };
  }

  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^([ \\t]*${escapedKey}[ \\t]*:)([^\\r\\n]*)(\\r?\\n|$)`, "im").exec(block.text);
  if (match?.index != null) {
    const from = block.from + match.index;
    const to = from + match[0].length;
    if (!value) return { changed: true, from, to, insert: "" };
    if (cleanMetadataScalar(match[2]) === value) return { changed: false, from: 0, to: 0, insert: "" };
    const spacing = match[2]?.match(/^[ \\t]*/)?.[0] || " ";
    return { changed: true, from, to, insert: `${match[1]}${spacing}${value}${match[3]}` };
  }
  if (!value) return { changed: false, from: 0, to: 0, insert: "" };

  const lineEnding = block.text.includes("\r\n") ? "\r\n" : "\n";
  const closePattern = block.kind === "org" ? /^[ \t]*#\+end[ \t]+meta[ \t]*$/gim : /^[ \t]*---[ \t]*$/gm;
  const close = [...block.text.matchAll(closePattern)].at(-1);
  if (!close || close.index == null) return { changed: false, from: 0, to: 0, insert: "" };
  const from = block.from + close.index;
  const prefix = close.index > 0 && !/[\r\n]$/.test(block.text.slice(0, close.index)) ? lineEnding : "";
  return { changed: true, from, to: from, insert: `${prefix}${key}: ${value}${lineEnding}` };
}

function minimalTextEdit(before: string, after: string, tags: string[]): MarkdownTagEdit {
  if (before === after) return { changed: false, from: 0, to: 0, insert: "", tags };
  let from = 0;
  const shared = Math.min(before.length, after.length);
  while (from < shared && before[from] === after[from]) from += 1;
  let beforeTo = before.length;
  let afterTo = after.length;
  while (beforeTo > from && afterTo > from && before[beforeTo - 1] === after[afterTo - 1]) {
    beforeTo -= 1;
    afterTo -= 1;
  }
  return { changed: true, from, to: beforeTo, insert: after.slice(from, afterTo), tags };
}

/**
 * Apply only the explicit add/remove intent to the latest editor document.
 * Untouched tags retain their spelling, order, quoting and list style.
 */
export function planMarkdownTagChanges(markdown: unknown, changes: TagChangeSet): MarkdownTagEdit {
  const text = String(markdown || "");
  const parsed = currentTagEntries(text);
  const next = applyTagChanges(parsed.entries, changes);
  const tags = stableTagList(next.map((entry) => entry.value));
  if (unchangedEntries(parsed.entries, next)) return { changed: false, from: 0, to: 0, insert: "", tags };
  if (parsed.field) {
    return {
      changed: true,
      from: parsed.field.from,
      to: parsed.field.to,
      insert: parsed.field.render(next),
      tags,
    };
  }
  if (next.length === 0) return { changed: false, from: 0, to: 0, insert: "", tags: [] };
  if (parsed.block) return insertTagField(parsed.block, next);
  const lineEnding = text.includes("\r\n") ? "\r\n" : "\n";
  const insert = `#+begin meta${lineEnding}tags: ${next.map((entry) => entry.raw).join(", ")}${lineEnding}#+end meta${lineEnding}${lineEnding}`;
  return { changed: true, from: 0, to: 0, insert, tags };
}

/**
 * Plan one editor transaction for the metadata form without serializing the
 * metadata block. Only the explicitly edited fields are touched.
 */
export function planMarkdownMetadataChanges(markdown: unknown, changes: MarkdownMetadataChangeSet): MarkdownTagEdit {
  const before = String(markdown || "");
  let after = before;
  if (changes.tags) after = applyTextEdit(after, planMarkdownTagChanges(after, changes.tags));
  if (Object.prototype.hasOwnProperty.call(changes, "project")) {
    after = applyTextEdit(after, planMetadataScalarChange(after, "project", changes.project));
  }
  return minimalTextEdit(before, after, metadataTagsFromMarkdown(after) ?? []);
}
