import { scanPlanningNodes } from "./planning-dsl.mjs";

function locate(nodes, selector = {}) {
  const kind = String(selector.kind || "").toLowerCase();
  const candidates = nodes.filter((node) => kind === "todo"
    ? node.kind === "todo" || node.kind === "itodo"
    : !kind || node.kind === kind);
  const index = Number(selector.index);
  if (Number.isInteger(index) && index >= 0) {
    const exact = candidates.find((node) => node.span.from === index
      && (selector.title ? node.title === selector.title : (!selector.source || node.raw === selector.source)));
    if (exact) return exact;
  }
  const stableId = String(selector.id || "").replace(/^#/, "");
  return candidates.find((node) => stableId && node.attrs?.id === stableId)
    || candidates.find((node) => selector.source && node.raw === selector.source)
    || candidates.find((node) => selector.title && node.title === selector.title)
    || candidates.find((node) => selector.open && node.attrs?.from && !node.attrs?.to)
    || null;
}

// Pure source contract mirrored by model.MutateMarkdownPlanning. This module
// is fixture/test-facing; production desktop mutations are executed by Go.
export function applyPlanningSourceMutation(input, selector = {}, mutation = {}) {
  const source = String(input || "");
  const type = String(mutation.type || "").toLowerCase();
  if (type === "append") {
    const baseContent = source || String(mutation.initialContent || "");
    const base = baseContent.replace(/\s*$/u, "");
    const prefix = base ? "\n\n" : "";
    const nextSource = String(mutation.source || "");
    const from = (base + prefix).length;
    return {
      content: base + prefix + nextSource + "\n",
      from, to: from + nextSource.length, source: "", nextSource,
    };
  }
  const node = locate(scanPlanningNodes(source), selector);
  if (!node) return null;
  if (type === "replace") {
    const nextSource = String(mutation.source || "");
    return {
      content: source.slice(0, node.span.from) + nextSource + source.slice(node.span.to),
      from: node.span.from, to: node.span.from + nextSource.length,
      source: node.raw, nextSource,
    };
  }
  if (type === "insert-after") {
    const newline = source.indexOf("\n", node.span.to);
    const from = newline < 0 ? source.length : newline + 1;
    let nextSource = String(mutation.source || "");
    if (newline < 0 && source && !source.endsWith("\n")) nextSource = "\n" + nextSource;
    if (!nextSource.endsWith("\n")) nextSource += "\n";
    return {
      content: source.slice(0, from) + nextSource + source.slice(from),
      from, to: from + nextSource.length, source: "", nextSource,
    };
  }
  throw new Error(`unsupported planning mutation ${JSON.stringify(type)}`);
}
