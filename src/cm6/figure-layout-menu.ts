import type { EditorView } from "@codemirror/view";
import type { Text } from "@codemirror/state";
import { imageLayoutFromAttrs, imageLayoutToAttrMap, type ImageLayoutAttrs } from "../image-attrs.ts";
import { LAYOUT_ATTR_KEYS, readLayoutAttrSuffix, readLayoutAttrsLine, readLayoutTrailingAttrs } from "../layout-attrs.ts";
import type { NoemaMenuItem } from "../menu-system.ts";

type FigureKind = "image" | "tikz" | "table" | "diagram";

export type FigureLayoutTarget = {
  kind: FigureKind;
  from: number;
  to: number;
  baseTo: number;
  layout: ImageLayoutAttrs;
  document: Text;
};

const FIGURE_SELECTOR = ".cm-image-widget, .cm-table-editable-block, .cm-mermaid-widget:not(.cm-mermaid-widget-preview)";
const LAYOUT_KEYS = new Set(LAYOUT_ATTR_KEYS);

function layoutSuffix(layout: ImageLayoutAttrs, previous: Record<string, string>): string {
  const attrs: Record<string, string> = {};
  for (const [key, value] of Object.entries(previous)) {
    if (!LAYOUT_KEYS.has(key)) attrs[key] = value;
  }
  Object.assign(attrs, imageLayoutToAttrMap(layout));
  // Keep a recognized layout key when only unrelated attrs remain, so the
  // widget continues to consume its own attribute block after a reset.
  if (Object.keys(attrs).length && !Object.keys(attrs).some((key) => LAYOUT_KEYS.has(key))) attrs.align = "center";
  const entries = Object.entries(attrs);
  return entries.length ? `{${entries.map(([key, value]) => `${key}=${/\s/.test(value) ? JSON.stringify(value) : value}`).join(" ")}}` : "";
}

/** Read only the widget's own source span, never the whole document. */
export function figureLayoutTarget(view: EditorView, node: EventTarget | null): FigureLayoutTarget | null {
  const element = node instanceof Element ? node : node instanceof Node ? node.parentElement : null;
  const widget = element?.closest<HTMLElement>(FIGURE_SELECTOR);
  if (!widget || !view.dom.contains(widget)) return null;
  const from = Number(widget.dataset.cmSourceFrom);
  const to = Number(widget.dataset.cmSourceTo);
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from || to > view.state.doc.length) return null;
  const doc = view.state.doc;
  let kind: FigureKind;
  let baseTo: number;
  let attrs: Record<string, string> = {};
  if (widget.classList.contains("cm-tikz-env-widget")) {
    kind = "tikz";
    const line = doc.lineAt(from);
    if (line.from !== from || !/^\s*#\+\s*begin\s+tikz\b/i.test(line.text)) return null;
    baseTo = line.to;
    const brace = line.text.indexOf("{");
    const parsed = brace >= 0 ? readLayoutAttrSuffix(line.text, brace) : null;
    if (parsed) attrs = parsed.attrs;
  } else if (widget.classList.contains("cm-table-editable-block")) {
    kind = "table";
    baseTo = Number(widget.dataset.cmSourceBaseTo);
    if (!Number.isSafeInteger(baseTo) || baseTo < from || baseTo > to || !doc.lineAt(from).text.includes("|")) return null;
    const next = baseTo < doc.length ? doc.line(doc.lineAt(baseTo).number + 1) : null;
    attrs = next && next.to === to ? readLayoutAttrsLine(next.text)?.attrs ?? {} : {};
  } else if (widget.classList.contains("cm-mermaid-widget")) {
    kind = "diagram";
    if (!/^\s*(?:`{3,}|~{3,})\s*(?:mermaid|mindmap|marmind|markmind)\b/i.test(doc.lineAt(from).text)) return null;
    const last = doc.lineAt(to);
    const parsed = last.to === to ? readLayoutAttrsLine(last.text) : null;
    baseTo = parsed && last.number > doc.lineAt(from).number ? doc.line(last.number - 1).to : to;
    attrs = parsed && baseTo < to ? parsed.attrs : {};
  } else {
    kind = "image";
    baseTo = Number(widget.dataset.cmSourceBaseTo);
    if (!Number.isSafeInteger(baseTo) || baseTo <= from || baseTo > to || !/^(?:!\[|\[\]\()/.test(doc.sliceString(from, Math.min(baseTo, from + 3)))) return null;
    const parsed = readLayoutTrailingAttrs(doc.sliceString(baseTo, to), 0);
    if (parsed) attrs = parsed.attrs;
  }
  return { kind, from, to, baseTo, layout: imageLayoutFromAttrs(attrs), document: doc };
}

export function applyFigureLayout(view: EditorView, target: FigureLayoutTarget, patch: Partial<ImageLayoutAttrs>): boolean {
  const doc = view.state.doc;
  if (target.document !== doc) return false;
  if (target.to > doc.length) return false;
  const next = { ...target.layout, ...patch };
  if (target.kind === "tikz") {
    const line = doc.lineAt(target.from);
    if (line.to !== target.baseTo || !/^\s*#\+\s*begin\s+tikz\b/i.test(line.text)) return false;
    const brace = line.text.indexOf("{");
    const old = brace >= 0 ? readLayoutAttrSuffix(line.text, brace) : null;
    const previous = old?.attrs ?? {};
    const head = old ? line.text.slice(0, old.from).trimEnd() : line.text.trimEnd();
    const suffix = layoutSuffix(next, previous);
    const insert = head + (suffix ? ` ${suffix}` : "");
    if (insert === line.text) return false;
    view.dispatch({ changes: { from: line.from, to: line.to, insert } });
  } else if (target.kind === "image") {
    if (target.baseTo > target.to || !/^(?:!\[|\[\]\()/.test(doc.sliceString(target.from, Math.min(target.baseTo, target.from + 3)))) return false;
    const old = readLayoutTrailingAttrs(doc.sliceString(target.baseTo, target.to), 0);
    const insert = layoutSuffix(next, old?.attrs ?? {});
    if (insert === doc.sliceString(target.baseTo, target.to)) return false;
    view.dispatch({ changes: { from: target.baseTo, to: target.to, insert } });
  } else {
    if (target.baseTo > target.to || doc.lineAt(target.baseTo).to !== target.baseTo) return false;
    const oldLine = target.baseTo < target.to ? doc.line(doc.lineAt(target.baseTo).number + 1) : null;
    const old = oldLine && oldLine.to === target.to ? readLayoutAttrsLine(oldLine.text) : null;
    if (target.baseTo < target.to && !old) return false;
    const suffix = layoutSuffix(next, old?.attrs ?? {});
    const from = oldLine && old ? oldLine.from : target.baseTo;
    const to = oldLine && old ? oldLine.to : target.baseTo;
    const insert = suffix ? (old ? suffix : `\n${suffix}`) : "";
    if (!suffix && old) {
      // Remove the separator newline along with the now-empty attribute line.
      view.dispatch({ changes: { from: target.baseTo, to, insert: "" } });
    } else if (insert !== doc.sliceString(from, to)) {
      view.dispatch({ changes: { from, to, insert } });
    } else return false;
  }
  view.requestMeasure();
  return true;
}

export function figureLayoutMenuItems(view: EditorView, target: FigureLayoutTarget, disabled = false): NoemaMenuItem[] {
  const apply = (patch: Partial<ImageLayoutAttrs>) => () => { if (!disabled) applyFigureLayout(view, target, patch); };
  const align = target.layout.align;
  const wrap = target.layout.wrap;
  return [
    { label: "Align Left", checked: align === "left" && !wrap, disabled, run: apply({ align: "left", wrap: false }) },
    { label: "Align Center", checked: align === "center" && !wrap, disabled, run: apply({ align: "center", wrap: false }) },
    { label: "Align Right", checked: align === "right" && !wrap, disabled, run: apply({ align: "right", wrap: false }) },
    { separator: true, label: "" },
    { label: "Wrap Text Left", checked: align === "left" && wrap, disabled, run: apply({ align: "left", wrap: true }) },
    { label: "Wrap Text Right", checked: align === "right" && wrap, disabled, run: apply({ align: "right", wrap: true }) },
    { separator: true, label: "" },
    { label: "Width", detail: target.layout.width || "Auto", disabled, submenu: [
      ...["25%", "50%", "75%", "100%"].map((width) => ({ label: width, checked: target.layout.width === width, run: apply({ width, height: "" }) })),
      { label: "Auto", checked: !target.layout.width, run: apply({ width: "", height: "" }) },
    ] },
    { label: "Reset Layout", disabled, run: apply({ align: "center", wrap: false, width: "", height: "" }) },
  ];
}
