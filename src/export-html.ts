import DOMPurify from "dompurify";

import { forEachDocumentViewTree } from "./document-view.ts";
import { renderMathLazy } from "./math-render.ts";

function renderMathElement(
  tex: string,
  el: HTMLElement,
  options: { displayMode: boolean },
): void {
  el.textContent = tex;
  renderMathLazy(tex, el, {
    displayMode: options.displayMode,
    throwOnError: false,
    strict: false,
    trust: false,
    output: "html",
  }, (error) => {
    el.classList.add("noema-math-error");
    el.textContent = error;
  });
}

function nodeText(node: ChildNode | null): string {
  return node?.textContent ?? "";
}

function isRenderedInlineMath(node: ChildNode | null): node is HTMLElement {
  return node instanceof HTMLElement && node.classList.contains("noema-math-inline");
}

function trimDelimiterBefore(mark: HTMLElement, delimiter: string): void {
  let prev = mark.previousSibling;
  if (prev instanceof Text && prev.data.endsWith(delimiter)) {
    prev.data = prev.data.slice(0, -delimiter.length);
    if (prev.data.length === 0) prev.remove();
    return;
  }
  if (prev instanceof HTMLElement && nodeText(prev) === delimiter) {
    const maybeWidget = prev.previousSibling;
    prev.remove();
    prev = maybeWidget;
  }
  if (isRenderedInlineMath(prev)) prev.remove();
}

function trimDelimiterAfter(mark: HTMLElement, delimiter: string): void {
  const next = mark.nextSibling;
  if (next instanceof Text && next.data.startsWith(delimiter)) {
    next.data = next.data.slice(delimiter.length);
    if (next.data.length === 0) next.remove();
    return;
  }
  if (next instanceof HTMLElement && nodeText(next) === delimiter) next.remove();
}

function renderInlineMathSources(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>("span[data-noema-math-mark]").forEach((mark) => {
    const tex = mark.getAttribute("data-tex") || mark.textContent || "";
    const display = mark.getAttribute("data-display") === "1";
    // Bracket delimiters are asymmetric. An explicit data-delimiter (legacy
    // symmetric form) overrides both sides; otherwise default to \( \) / \[ \].
    const explicit = mark.getAttribute("data-delimiter");
    const openDelimiter = explicit || (display ? "\\[" : "\\(");
    const closeDelimiter = explicit || (display ? "\\]" : "\\)");
    const rendered = document.createElement("span");
    rendered.className = display ? "noema-math-block" : "noema-math-inline";
    rendered.setAttribute("data-tex", tex);
    renderMathElement(tex, rendered, { displayMode: display });

    trimDelimiterBefore(mark, openDelimiter);
    trimDelimiterAfter(mark, closeDelimiter);
    mark.replaceWith(rendered);
  });
}

function renderDisplayMathBlocks(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>("math-block[data-noema-math-block], math-block").forEach((block) => {
    const source = block.querySelector<HTMLElement>(".math-block-source");
    if (!source) return;
    const tex = source.textContent?.trim() ?? "";
    let rendered = block.querySelector<HTMLElement>(".math-block-render");
    if (!rendered) {
      rendered = document.createElement("div");
      block.appendChild(rendered);
    }
    rendered.className = "noema-math-block math-block-render";
    rendered.setAttribute("contenteditable", "false");
    renderMathElement(tex, rendered, { displayMode: true });
    block.classList.add("math-block-rendered");
    block.classList.remove("math-block-active");
  });
}

function renderOrgEnvBlocks(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>("org-env-block").forEach((block) => {
    block.classList.remove("org-env-active", "org-env-comment-open");
    block.querySelectorAll<HTMLInputElement>("input.org-env-heading-title").forEach((input) => {
      const title = input.value || block.dataset.title || "";
      const span = document.createElement("span");
      span.className = input.className;
      span.dataset.empty = title ? "false" : "true";
      span.textContent = title;
      if (input.hidden) span.hidden = true;
      input.replaceWith(span);
    });
  });
}

function prepareStaticExportHTML(root: ParentNode): void {
  renderInlineMathSources(root);
  renderDisplayMathBlocks(root);
  renderOrgEnvBlocks(root);
}

const MATHML_POLICY = { USE_PROFILES: { mathMl: true }, ADD_ATTR: ["xmlns", "display"] };

// A private-use character separates the formulas sanitized in one call;
// KaTeX output and DOMPurify never produce it.
const MATHML_SPLIT = "";

function protectMathML(html: string): { html: string; math: string[] } {
  const pieces: string[] = [];
  const replaced = html.replace(/<math\b[\s\S]*?<\/math>/gi, (match) => {
    const index = pieces.push(match) - 1;
    return `\\uE000NOEMA_MATHML_${index}\\uE000`;
  });
  if (pieces.length === 0) return { html: replaced, math: [] };
  // One DOMPurify document for every formula instead of one each.  Each piece
  // keeps its own <div> wrapper exactly as a separate call returned it, and the
  // sanitizer works node by node, so pieces cannot affect each other.
  const math = String(DOMPurify.sanitize(
    pieces.map((piece) => `<div>${piece}</div>`).join(MATHML_SPLIT), MATHML_POLICY,
  )).split(MATHML_SPLIT);
  if (math.length === pieces.length) return { html: replaced, math };
  // Not expected; sanitize one by one rather than misplace a formula.
  return {
    html: replaced,
    math: pieces.map((piece) => String(DOMPurify.sanitize(`<div>${piece}</div>`, MATHML_POLICY))),
  };
}

function restoreMathML(html: string, math: readonly string[]): string {
  return html.replace(/\\uE000NOEMA_MATHML_(\d+)\\uE000/g, (_match, rawIndex: string) => {
    const index = Number(rawIndex);
    return math[index] ?? "";
  });
}

function restoreVisualSrcdoc(html: string, srcdocs: readonly string[]): string {
  return html.replace(/\sdata-noema-protected-srcdoc="(\d+)"/g, (_match, rawIndex: string) => {
    const index = Number(rawIndex);
    const value = srcdocs[index];
    return value === undefined ? "" : ` srcdoc="${value}"`;
  });
}

function protectVisualSrcdocAttrs(root: ParentNode, srcdocs: string[]): void {
  root.querySelectorAll<HTMLIFrameElement>("iframe.noema-visual-embed[srcdoc]").forEach((frame) => {
    const value = frame.getAttribute("srcdoc");
    if (value == null) return;
    const index = srcdocs.push(escapeAttrForProtectedSrcdoc(value)) - 1;
    frame.removeAttribute("srcdoc");
    frame.setAttribute("data-noema-protected-srcdoc", String(index));
  });
}

function escapeAttrForProtectedSrcdoc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function protectVisualIframeAttrs(html: string): { html: string; attrs: string[] } {
  const attrs: string[] = [];
  return {
    html: html.replace(/<iframe\b(?=[^>]*\bnoema-visual-embed\b)([^>]*)>/g, (_match, rawAttrs: string) => {
      const protectedAttrs: string[] = [];
      const remaining = rawAttrs.replace(/\s(allow|loading|referrerpolicy|sandbox)="([^"]*)"/g, (_attr, name: string, value: string) => {
        protectedAttrs.push(`${name}="${value}"`);
        return "";
      });
      if (protectedAttrs.length === 0) return `<iframe${rawAttrs}>`;
      const index = attrs.push(protectedAttrs.join(" ")) - 1;
      return `<iframe${remaining} data-noema-protected-frame-attrs="${index}">`;
    }),
    attrs,
  };
}

function restoreVisualIframeAttrs(html: string, attrs: readonly string[]): string {
  return html.replace(/\sdata-noema-protected-frame-attrs="(\d+)"/g, (_match, rawIndex: string) => {
    const index = Number(rawIndex);
    const value = attrs[index];
    return value === undefined ? "" : ` ${value}`;
  });
}

function stripAttrs(el: Element): void {
  for (const attr of Array.from(el.attributes)) {
    if (attr.name === "class" && attr.value.trim() === "") {
      el.removeAttribute(attr.name);
    } else if (
      attr.name === "contenteditable" ||
      attr.name === "data-pos" ||
      attr.name === "data-unsafe-href" ||
      (attr.name.startsWith("aria-") && !(el.localName === "progress" && attr.name === "aria-label")
        && !((attr.name === "aria-label" || attr.name === "aria-hidden") && el.closest(".noema-chart"))
        && !((attr.name === "aria-label" || attr.name === "aria-sort") && el.closest(".noema-document-table-view"))
        && !(attr.name === "aria-hidden" && el.classList.contains("noema-document-card-icon"))
        && !(attr.name === "aria-hidden" && el.classList.contains("noema-qr-symbol"))
        && !((attr.name === "aria-label" || attr.name === "aria-hidden" || attr.name === "aria-current") && el.closest(".noema-document-breadcrumb"))
        && !(attr.name === "aria-current" && el.parentElement?.classList.contains("noema-steps-list")))
    ) {
      el.removeAttribute(attr.name);
    }
  }
}

// Editor-only chrome that exported HTML drops.  These are native
// querySelectorAll passes: in WebKit, where the renderer runs, they beat a
// JavaScript tree walk for widget-sized fragments (measured: 200 paragraphs of
// GraphTensor.md, 372 ms with these against 421 ms with one JS walk).
const EDITOR_ONLY_SELECTOR = [
  ".cb-chrome",
  ".emoji-completion",
  ".file-input",
  ".play-caret",
  ".syntax-hidden",
  ".syntax-hint",
  ".syntax-hint-italic",
  ".math-source-hidden",
  "math-block.math-block-rendered > .math-block-fence",
  "math-block.math-block-rendered > .math-block-source",
  "pre.cb-diagram-rendered:not(.cb-diagram-error) > code",
  "[hidden]",
].join(",");

function removeEditorOnlyAndStripAttrs(root: ParentNode): void {
  root.querySelectorAll(EDITOR_ONLY_SELECTOR).forEach((node) => node.remove());
  root.querySelectorAll("*").forEach(stripAttrs);
  if (root instanceof Element) stripAttrs(root);
}

/**
 * Serialize ROOT as exported HTML.  ROOT is cloned first unless IN_PLACE,
 * which a caller passes for a throwaway root it built for this call.
 */
export function cleanEditorHTML(root: HTMLElement, inPlace = false): string {
  const clone = inPlace ? root : root.cloneNode(true) as HTMLElement;
  const protectedSrcdocs: string[] = [];
  forEachDocumentViewTree(clone, (tree) => {
    prepareStaticExportHTML(tree);
    removeEditorOnlyAndStripAttrs(tree);
    protectVisualSrcdocAttrs(tree, protectedSrcdocs);
  });
  const protectedHtml = protectMathML(clone.innerHTML);
  const protectedFrameAttrs = protectVisualIframeAttrs(protectedHtml.html);
  const sanitized = DOMPurify.sanitize(protectedFrameAttrs.html, {
    USE_PROFILES: { html: true, svg: true, mathMl: true },
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|file|zotero|roam|noema|noema-asset|marginnote(?:\d+)?(?:app)?):|[#/]|\.{0,2}\/|[A-Za-z0-9._~!$&'()*+,;=@%-]+(?:[/?#]|$))/i,
    ADD_TAGS: [
      "math",
      "mrow",
      "mi",
      "mn",
      "mo",
      "msup",
      "msub",
      "msubsup",
      "mfrac",
      "msqrt",
      "mroot",
      "mtable",
      "mtr",
      "mtd",
      "semantics",
      "annotation",
      "math-block",
      "org-env-block",
      "noema-tikz",
      "mark-comment",
      "ref-def",
      "ref-label",
      "ref-url",
      "ref-title",
      "yaml-block",
      "iframe",
    ],
    ADD_ATTR: [
      "xmlns",
      "viewBox",
      "d",
      "x",
      "y",
      "x1",
      "y1",
      "x2",
      "y2",
      "cx",
      "cy",
      "r",
      "rx",
      "ry",
      "width",
      "height",
      "fill",
      "stroke",
      "stroke-width",
      "shape-rendering",
      "transform",
      "points",
      "data-kind",
      "data-title",
      "data-label",
      "data-empty",
      "data-outline-level",
      "data-section-kind",
      "data-section-label",
      "data-lean-region",
      "data-tex",
      "data-math-render-key",
      "data-noema-math-block",
      "data-noema-image-align",
      "data-noema-image-wrap",
      "data-noema-visual-kind",
      "data-noema-dom-src-index",
      "data-noema-dom-srcdoc-index",
      "data-noema-protected-srcdoc",
      "data-noema-protected-frame-attrs",
      "data-noema-cell-command",
      "href",
      "src",
      "srcdoc",
      "title",
      "loading",
      "sandbox",
      "allow",
      "referrerpolicy",
    ],
  });
  const restoredFrameAttrs = restoreVisualIframeAttrs(sanitized, protectedFrameAttrs.attrs);
  const restoredSrcdoc = restoreVisualSrcdoc(restoredFrameAttrs, protectedSrcdocs);
  return restoreMathML(restoredSrcdoc, protectedHtml.math);
}
