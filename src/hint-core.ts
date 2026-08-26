/**
 * Editor-neutral hint/slash-menu primitives.
 *
 * Adapted from SiYuan's
 * `app/src/protyle/hint/{slashMenu,blockHintRange}.ts` and
 * `app/src/config/entryVisibility/order.ts` (AGPL-3.0).  The DOM Range and
 * protyle session portions deliberately stay out of this module: Noema uses
 * Markdown source offsets and its existing CM6 completion surface.
 */

export type HintMenuItem = {
  entryKey: string;
  filter?: readonly string[];
  separator?: boolean;
};

export type ResolveHintMenuOptions = {
  enabled?: boolean;
  query?: string;
  order?: readonly string[];
  visible?: (entryKey: string) => boolean;
};

export type HintTriggerDefinition = {
  key: string;
  close?: string;
  kind?: "block" | "tag" | "slash" | "emoji" | "other";
};

export type HintTriggerMatch = {
  key: string;
  kind: NonNullable<HintTriggerDefinition["kind"]>;
  query: string;
  /** UTF-16 offset within the current line. */
  offset: number;
  /** Number of Markdown source units to replace before the cursor. */
  deleteBefore: number;
};

function isSeparator(item: HintMenuItem | undefined): boolean {
  return item?.separator === true;
}

/** Keep unconfigured/plugin entries in their registration slots. */
export function reorderHintEntrySlots<T extends HintMenuItem>(
  items: readonly T[],
  order: readonly string[],
): T[] {
  const orderIndexes = new Map(order.map((key, index) => [key, index]));
  const configurableIndexes: number[] = [];
  const configurableItems: T[] = [];
  items.forEach((item, index) => {
    if (!orderIndexes.has(item.entryKey)) return;
    configurableIndexes.push(index);
    configurableItems.push(item);
  });
  configurableItems.sort((left, right) => (
    (orderIndexes.get(left.entryKey) ?? Number.MAX_SAFE_INTEGER)
      - (orderIndexes.get(right.entryKey) ?? Number.MAX_SAFE_INTEGER)
  ));
  const result = [...items];
  configurableIndexes.forEach((index, configurableIndex) => {
    result[index] = configurableItems[configurableIndex]!;
  });
  return result;
}

export function normalizeHintMenuSeparators<T extends HintMenuItem>(items: readonly T[]): T[] {
  const result: T[] = [];
  for (const item of items) {
    if (isSeparator(item)) {
      if (result.length > 0 && !isSeparator(result[result.length - 1])) result.push(item);
      continue;
    }
    result.push(item);
  }
  if (isSeparator(result[result.length - 1])) result.pop();
  return result;
}

export function resolveHintMenuItems<T extends HintMenuItem>(
  items: readonly T[],
  options: ResolveHintMenuOptions = {},
): T[] {
  if (options.enabled === false) return [];

  const entryKeys = new Set<string>();
  const uniqueItems = items.filter((item) => {
    if (entryKeys.has(item.entryKey)) return false;
    entryKeys.add(item.entryKey);
    return true;
  });
  const ordered = reorderHintEntrySlots(uniqueItems, options.order ?? []);
  const visible = ordered.filter((item) => (
    isSeparator(item) || (options.visible?.(item.entryKey) ?? true)
  ));
  const query = (options.query ?? "").trim().toLocaleLowerCase();
  const filtered = query
    ? visible.filter((item) => isSeparator(item) || item.filter?.some((value) => (
      value.toLocaleLowerCase().includes(query)
    )))
    : visible;
  return normalizeHintMenuSeparators(filtered);
}

export function getBlockHintTriggerOffset(
  textBeforeCaret: string,
  textAfterCaret: string,
  splitChar: string,
  endSplit: string,
): number {
  const latestOffset = textBeforeCaret.lastIndexOf(splitChar);
  if (latestOffset < 0 || textAfterCaret.startsWith(endSplit)) return latestOffset;
  const tripleOffset = textBeforeCaret.lastIndexOf(splitChar + splitChar.slice(0, 1));
  return tripleOffset > -1 ? Math.min(latestOffset, tripleOffset) : latestOffset;
}

export function getBlockRefStaticText(
  selectedText: string,
  splitChar: string,
  includesTrigger: boolean,
): string {
  return includesTrigger ? selectedText.slice(splitChar.length) : selectedText;
}

export function shouldIgnoreHintTrigger(
  activeHint: string,
  candidateHint: string,
  blockHintKeys: readonly string[],
): boolean {
  if (blockHintKeys.includes(activeHint) && [":", "#", "/", "、"].includes(candidateHint)) return true;
  return activeHint === "#" && ["/", "、"].includes(candidateHint);
}

export function endsWithMultiCharHintPrefix(key: string, hintKeys: readonly string[]): boolean {
  return hintKeys.some((hintKey) => hintKey.length > 1 && key.endsWith(hintKey.slice(0, 1)));
}

function escapedAt(text: string, index: number): boolean {
  let escapes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor--) escapes++;
  return escapes % 2 === 1;
}

function slashBoundary(line: string, offset: number): boolean {
  if (offset === 0) return true;
  const previous = line[offset - 1] ?? "";
  return /[\s([{>"']/.test(previous);
}

/**
 * Resolve the right-most trigger on the current source line.  The caller owns
 * syntax-aware suppression (for example fenced code), while this helper owns
 * overlapping multi-character markers, trigger priority and URL/path safety.
 */
export function findHintTrigger(
  textBeforeCaret: string,
  textAfterCaret: string,
  definitions: readonly HintTriggerDefinition[],
  activeHint = "",
): HintTriggerMatch | null {
  const lineStart = textBeforeCaret.lastIndexOf("\n") + 1;
  const line = textBeforeCaret.slice(lineStart);
  const afterLine = textAfterCaret.split("\n", 1)[0] ?? "";
  const blockHintKeys = definitions
    .filter((definition) => definition.kind === "block")
    .map((definition) => definition.key);
  let best: HintTriggerMatch | null = null;

  for (const definition of definitions) {
    if (!definition.key || shouldIgnoreHintTrigger(activeHint, definition.key, blockHintKeys)) continue;
    const offset = definition.close
      ? getBlockHintTriggerOffset(line, afterLine, definition.key, definition.close)
      : line.lastIndexOf(definition.key);
    if (offset < 0 || escapedAt(line, offset)) continue;
    if ((definition.kind === "slash" || definition.key === "/" || definition.key === "、")
      && !slashBoundary(line, offset)) continue;
    if (best && offset < best.offset) continue;
    const query = line.slice(offset + definition.key.length);
    if (query.includes("\t")) continue;
    best = {
      key: definition.key,
      kind: definition.kind ?? "other",
      query,
      offset,
      deleteBefore: definition.key.length + query.length,
    };
  }
  return best;
}

export function findSlashHint(
  textBeforeCaret: string,
  textAfterCaret: string,
): HintTriggerMatch | null {
  const match = findHintTrigger(textBeforeCaret, textAfterCaret, [
    { key: "/", kind: "slash" },
    { key: "、", kind: "slash" },
  ]);
  if (!match || /\s{2,}/.test(match.query)) return null;
  return match;
}
