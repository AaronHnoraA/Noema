/**
 * Office/PowerPoint list repair adapted from SiYuan's
 * app/src/protyle/util/officeList.ts (AGPL-3.0).
 *
 * This module is deliberately editor-neutral: pasted Office HTML is repaired
 * into semantic HTML before Noema sanitizes it and converts it to Markdown.
 */

export type OfficeListSource = "word" | "ppt";
export type OfficeListType = "ul" | "ol" | "task";

export interface OfficeListModel {
  level: number;
  type: OfficeListType;
  identity: string;
  checked?: boolean;
  markerOrdinal?: number;
}

export interface OfficeListPlanItem {
  sourceIndex: number;
  checked?: boolean;
  children: OfficeListPlan[];
}

export interface OfficeListPlan {
  type: OfficeListType;
  identity: string;
  start?: number;
  items: OfficeListPlanItem[];
}

export interface OfficeListConversionResult {
  html: string;
  convertedCount: number;
  source?: OfficeListSource;
}

interface ExtractedOfficeListItem {
  element: Element;
  content: Element;
  model: OfficeListModel;
  source: OfficeListSource;
}

interface OfficeListFrame {
  container: OfficeListPlan[];
  level: number;
  list: OfficeListPlan;
}

interface OrderedMarker {
  ordinal: number;
  format: "number" | "letter" | "roman";
}

const LEVEL_EPSILON = 0.5;
const UNCHECKED_TASK_MARKERS = new Set(["□", "☐"]);
const CHECKED_TASK_MARKERS = new Set(["✔", "✓", "☑", "☒"]);
const UNORDERED_MARKERS = new Set([
  "•", "·", "●", "○", "◦", "▪", "▫", "■", "□", "◆", "◇", "‣", "⁃", "-", "–", "—",
]);

export function parseInlineStyle(style: string): Record<string, string> {
  const result: Record<string, string> = {};
  let segment = "";
  let quote = "";
  let parentheses = 0;
  const segments: string[] = [];

  for (const character of style) {
    if (quote) {
      segment += character;
      if (character === quote) quote = "";
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      segment += character;
      continue;
    }
    if (character === "(") parentheses++;
    else if (character === ")" && parentheses > 0) parentheses--;
    if (character === ";" && parentheses === 0) {
      segments.push(segment);
      segment = "";
    } else {
      segment += character;
    }
  }
  segments.push(segment);

  for (const item of segments) {
    const colon = item.indexOf(":");
    if (colon < 0) continue;
    const name = item.slice(0, colon).trim().toLowerCase();
    if (name) result[name] = item.slice(colon + 1).trim();
  }
  return result;
}

export function parseWordListStyle(style: string): { level: number; identity: string } | undefined {
  const value = parseInlineStyle(style)["mso-list"];
  if (!value || /^ignore$/i.test(value.trim())) return undefined;
  const list = value.match(/\bl\s*(\d+)\b/i);
  const level = value.match(/\blevel\s*(\d+)\b/i);
  const override = value.match(/\blfo\s*(\d+)\b/i);
  if (!list || !level || !override) return undefined;
  return {
    level: Number.parseInt(level[1], 10),
    identity: `word:l${Number.parseInt(list[1], 10)}:lfo${Number.parseInt(override[1], 10)}`,
  };
}

export function parsePptSpecialFormat(style: string): "bullet" | "numbullet" | undefined {
  const value = parseInlineStyle(style)["mso-special-format"]?.trim().toLowerCase();
  const normalized = value?.replace(/^(["'])(.*)\1$/, "$2").trim();
  if (normalized && /^numbullet(?:[\d\\,]+)?$/.test(normalized)) return "numbullet";
  return normalized && /^bullet(?:[\d\\,]+)?$/.test(normalized) ? "bullet" : undefined;
}

export function parseCssLengthToPoints(value: string): number | undefined {
  const match = value.trim().match(/^(-?(?:\d+(?:\.\d*)?|\.\d+))\s*(in|pt|px|pc|cm|mm)?$/i);
  if (!match) return undefined;
  const amount = Number.parseFloat(match[1]);
  switch (match[2]?.toLowerCase()) {
    case "in": return amount * 72;
    case "px": return amount * 0.75;
    case "pc": return amount * 12;
    case "cm": return amount * 72 / 2.54;
    case "mm": return amount * 72 / 25.4;
    default: return amount;
  }
}

function normalizeMarkerText(marker: string): string {
  return marker.replace(/[\s\u00a0\u200b\u200e\u200f]+/g, "");
}

function alphabeticOrdinal(value: string): number {
  let result = 0;
  for (const character of value.toUpperCase()) {
    result = result * 26 + character.charCodeAt(0) - 64;
  }
  return result;
}

function romanOrdinal(value: string): number | undefined {
  const values: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  let result = 0;
  let previous = 0;
  for (const character of Array.from(value.toUpperCase()).reverse()) {
    const current = values[character];
    if (!current) return undefined;
    if (current < previous) result -= current;
    else {
      result += current;
      previous = current;
    }
  }
  return result;
}

export function parseOrderedMarker(marker: string): OrderedMarker | undefined {
  const normalized = normalizeMarkerText(marker);
  const match = normalized.match(/^(?:\(([^()]+)\)|([^().、]+)[.)、])$/);
  const value = match?.[1] ?? match?.[2];
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return { ordinal: Number.parseInt(value, 10), format: "number" };
  if (/^[a-z]$/i.test(value)) return { ordinal: alphabeticOrdinal(value), format: "letter" };
  if (/^[ivxlcdm]+$/i.test(value)) {
    const ordinal = romanOrdinal(value);
    return ordinal ? { ordinal, format: "roman" } : undefined;
  }
  if (/^[a-z]+$/i.test(value)) return { ordinal: alphabeticOrdinal(value), format: "letter" };
  return undefined;
}

export function detectTaskMarker(marker: string, font: string): boolean | undefined {
  const normalized = normalizeMarkerText(marker);
  if (UNCHECKED_TASK_MARKERS.has(normalized)) return false;
  if (CHECKED_TASK_MARKERS.has(normalized)) return true;
  if (/wingdings\s*2/i.test(font)) {
    if (normalized === "£" || normalized === "\uF0A3") return false;
    if (["P", "\uF050", "R", "\uF052"].includes(normalized)) return true;
    return undefined;
  }
  if (/wingdings/i.test(font)) {
    if (["p", "\uF070", "q", "\uF071"].includes(normalized)) return false;
    if (normalized === "ü" || normalized === "\uF0FC") return true;
  }
  return undefined;
}

export function classifyWordMarker(marker: string, font: string): Pick<OfficeListModel, "type" | "checked" | "markerOrdinal"> | undefined {
  const checked = detectTaskMarker(marker, font);
  if (checked !== undefined) return { type: "task", checked };
  const normalized = normalizeMarkerText(marker);
  if (/wingdings|webdings|symbol|courier\s+new/i.test(font)) {
    return normalized ? { type: "ul" } : undefined;
  }
  const ordered = parseOrderedMarker(normalized);
  if (ordered) return { type: "ol", markerOrdinal: ordered.ordinal };
  if (normalized === "l" || normalized === "n" || UNORDERED_MARKERS.has(normalized)
    || (normalized.length === 1 && /[^\p{L}\p{N}]/u.test(normalized))) {
    return { type: "ul" };
  }
  return undefined;
}

export function classifyPptMarker(
  marker: string,
  font: string,
  specialFormat: "bullet" | "numbullet",
): Pick<OfficeListModel, "type" | "checked" | "markerOrdinal"> {
  const checked = detectTaskMarker(marker, font);
  if (checked !== undefined) return { type: "task", checked };
  if (specialFormat === "numbullet") {
    return { type: "ol", markerOrdinal: parseOrderedMarker(marker)?.ordinal };
  }
  return { type: "ul" };
}

export function groupConsecutiveOfficeListItems<T>(items: Array<T | null | undefined>): T[][] {
  const groups: T[][] = [];
  let current: T[] = [];
  for (const item of items) {
    if (item === null || item === undefined) {
      if (current.length > 0) {
        groups.push(current);
        current = [];
      }
    } else {
      current.push(item);
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function compareLevels(left: number, right: number): number {
  if (Math.abs(left - right) < LEVEL_EPSILON) return 0;
  return left < right ? -1 : 1;
}

function canContinueList(list: OfficeListPlan, item: OfficeListModel, items: readonly OfficeListModel[]): boolean {
  if (list.type !== item.type || list.identity !== item.identity) return false;
  if (item.type !== "ol" || item.markerOrdinal === undefined || list.items.length === 0) return true;
  const previous = items[list.items[list.items.length - 1].sourceIndex].markerOrdinal;
  return previous === undefined || item.markerOrdinal === previous + 1;
}

function createPlan(item: OfficeListModel): OfficeListPlan {
  return {
    type: item.type,
    identity: item.identity,
    start: item.type === "ol" ? item.markerOrdinal : undefined,
    items: [],
  };
}

function appendPlanItem(list: OfficeListPlan, sourceIndex: number, item: OfficeListModel): void {
  list.items.push({ sourceIndex, checked: item.checked, children: [] });
}

export function buildOfficeListPlan(items: readonly OfficeListModel[]): OfficeListPlan[] {
  const roots: OfficeListPlan[] = [];
  const stack: OfficeListFrame[] = [];

  items.forEach((item, sourceIndex) => {
    while (stack.length > 0 && compareLevels(item.level, stack[stack.length - 1].level) < 0) stack.pop();

    if (stack.length === 0) {
      const list = createPlan(item);
      roots.push(list);
      appendPlanItem(list, sourceIndex, item);
      stack.push({ container: roots, level: item.level, list });
      return;
    }

    const top = stack[stack.length - 1];
    const relation = compareLevels(item.level, top.level);
    if (relation > 0) {
      const parentItem = top.list.items[top.list.items.length - 1];
      const container = parentItem.children;
      let list = container[container.length - 1];
      if (!list || !canContinueList(list, item, items)) {
        list = createPlan(item);
        container.push(list);
      }
      appendPlanItem(list, sourceIndex, item);
      stack.push({ container, level: item.level, list });
      return;
    }

    if (canContinueList(top.list, item, items)) {
      appendPlanItem(top.list, sourceIndex, item);
      return;
    }

    const list = createPlan(item);
    top.container.push(list);
    appendPlanItem(list, sourceIndex, item);
    stack[stack.length - 1] = { container: top.container, level: item.level, list };
  });

  return roots;
}

function isWordMarker(element: Element): boolean {
  const value = parseInlineStyle(element.getAttribute("style") ?? "")["mso-list"];
  return /^ignore$/i.test(value?.trim() ?? "");
}

function markerFont(marker: Element, item: Element): string {
  const fonts: string[] = [];
  Array.from(marker.querySelectorAll("[style]")).forEach((child) => {
    const style = parseInlineStyle(child.getAttribute("style") ?? "");
    if (style["font-family"]) fonts.push(style["font-family"]);
    if (style.font) fonts.push(style.font);
  });
  let current: Element | null = marker;
  while (current) {
    const style = parseInlineStyle(current.getAttribute("style") ?? "");
    if (style["font-family"]) fonts.push(style["font-family"]);
    if (style.font) fonts.push(style.font);
    if (current === item) break;
    current = current.parentElement;
  }
  return fonts.join(" ");
}

function styledDescendants(element: Element): Element[] {
  return Array.from(element.querySelectorAll("[style]"));
}

function cloneWithoutMarkers(element: Element, predicate: (item: Element) => boolean): Element {
  const clone = element.cloneNode(true) as Element;
  styledDescendants(clone).filter(predicate).forEach((item) => item.remove());
  return clone;
}

function extractWordListItem(element: Element): ExtractedOfficeListItem | undefined {
  const list = parseWordListStyle(element.getAttribute("style") ?? "");
  if (!list) return undefined;
  const marker = styledDescendants(element).find(isWordMarker);
  if (!marker) return undefined;
  const classification = classifyWordMarker(marker.textContent ?? "", markerFont(marker, element));
  if (!classification) return undefined;
  return {
    element,
    content: cloneWithoutMarkers(element, isWordMarker),
    model: { level: list.level, identity: list.identity, ...classification },
    source: "word",
  };
}

function extractPptListItem(element: Element): ExtractedOfficeListItem | undefined {
  const style = parseInlineStyle(element.getAttribute("style") ?? "");
  const level = style["margin-left"] === undefined ? undefined : parseCssLengthToPoints(style["margin-left"]);
  if (level === undefined) return undefined;
  const marker = styledDescendants(element)
    .find((item) => parsePptSpecialFormat(item.getAttribute("style") ?? "") !== undefined);
  if (!marker) return undefined;
  const specialFormat = parsePptSpecialFormat(marker.getAttribute("style") ?? "");
  if (!specialFormat) return undefined;
  const classification = classifyPptMarker(marker.textContent ?? "", markerFont(marker, element), specialFormat);
  return {
    element,
    content: cloneWithoutMarkers(
      element,
      (item) => parsePptSpecialFormat(item.getAttribute("style") ?? "") !== undefined,
    ),
    model: { level, identity: "ppt", ...classification },
    source: "ppt",
  };
}

function extractOfficeListItem(element: Element): ExtractedOfficeListItem | undefined {
  return extractWordListItem(element) ?? extractPptListItem(element);
}

function renderOfficeListPlans(
  doc: Document,
  plans: readonly OfficeListPlan[],
  items: readonly ExtractedOfficeListItem[],
): DocumentFragment {
  const fragment = doc.createDocumentFragment();
  for (const plan of plans) {
    const list = doc.createElement(plan.type === "ol" ? "ol" : "ul");
    if (plan.type === "task") list.setAttribute("data-type", "task");
    else if (plan.type === "ol" && plan.start !== undefined && plan.start !== 1) {
      list.setAttribute("start", plan.start.toString());
    }
    for (const planItem of plan.items) {
      const item = items[planItem.sourceIndex];
      const listItem = doc.createElement("li");
      if (plan.type === "task") {
        const checkbox = doc.createElement("input");
        checkbox.setAttribute("type", "checkbox");
        if (planItem.checked) checkbox.setAttribute("checked", "checked");
        listItem.classList.add("task-list-item");
        listItem.appendChild(checkbox);
      }
      while (item.content.firstChild) listItem.appendChild(item.content.firstChild);
      listItem.appendChild(renderOfficeListPlans(doc, planItem.children, items));
      list.appendChild(listItem);
    }
    fragment.appendChild(list);
  }
  return fragment;
}

function shouldSkipContainer(element: Element): boolean {
  return ["UL", "OL", "SCRIPT", "STYLE"].includes(element.tagName);
}

function convertContainer(container: Element, convertedSources: Set<OfficeListSource>): number {
  const children = Array.from(container.children);
  const extracted = children.map(extractOfficeListItem);
  let convertedCount = 0;

  children.forEach((child, index) => {
    if (!extracted[index] && !shouldSkipContainer(child)) {
      convertedCount += convertContainer(child, convertedSources);
    }
  });

  for (const group of groupConsecutiveOfficeListItems(extracted)) {
    const plans = buildOfficeListPlan(group.map((item) => item.model));
    const fragment = renderOfficeListPlans(container.ownerDocument, plans, group);
    group[0].element.before(fragment);
    for (const item of group) {
      convertedSources.add(item.source);
      item.element.remove();
      convertedCount++;
    }
  }
  return convertedCount;
}

export function convertOfficeLists(html: string): OfficeListConversionResult {
  if (typeof DOMParser === "undefined" || !/mso-(?:list|special-format)\s*:/i.test(html)) {
    return { html, convertedCount: 0 };
  }
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const sources = new Set<OfficeListSource>();
    const convertedCount = convertContainer(doc.body, sources);
    if (convertedCount === 0) return { html, convertedCount };
    return {
      html: doc.body.innerHTML,
      convertedCount,
      source: sources.has("ppt") ? "ppt" : "word",
    };
  } catch (error) {
    console.warn("convert office list failed", error);
    return { html, convertedCount: 0 };
  }
}
