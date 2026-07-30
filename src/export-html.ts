import DOMPurify from "dompurify";

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
    el.classList.add("aaronnote-math-error");
    el.textContent = error;
  });
}

function nodeText(node: ChildNode | null): string {
  return node?.textContent ?? "";
}

function isRenderedInlineMath(node: ChildNode | null): node is HTMLElement {
  return node instanceof HTMLElement && node.classList.contains("aaronnote-math-inline");
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

function renderInlineMathSources(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>("span[data-aaronnote-math-mark]").forEach((mark) => {
    const tex = mark.getAttribute("data-tex") || mark.textContent || "";
    const display = mark.getAttribute("data-display") === "1";
    // Bracket delimiters are asymmetric. An explicit data-delimiter (legacy
    // symmetric form) overrides both sides; otherwise default to \( \) / \[ \].
    const explicit = mark.getAttribute("data-delimiter");
    const openDelimiter = explicit || (display ? "\\[" : "\\(");
    const closeDelimiter = explicit || (display ? "\\]" : "\\)");
    const rendered = document.createElement("span");
    rendered.className = display ? "aaronnote-math-block" : "aaronnote-math-inline";
    rendered.setAttribute("data-tex", tex);
    renderMathElement(tex, rendered, { displayMode: display });

    trimDelimiterBefore(mark, openDelimiter);
    trimDelimiterAfter(mark, closeDelimiter);
    mark.replaceWith(rendered);
  });
}

function renderDisplayMathBlocks(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>("math-block[data-aaronnote-math-block], math-block").forEach((block) => {
    const source = block.querySelector<HTMLElement>(".math-block-source");
    if (!source) return;
    const tex = source.textContent?.trim() ?? "";
    let rendered = block.querySelector<HTMLElement>(".math-block-render");
    if (!rendered) {
      rendered = document.createElement("div");
      block.appendChild(rendered);
    }
    rendered.className = "aaronnote-math-block math-block-render";
    rendered.setAttribute("contenteditable", "false");
    renderMathElement(tex, rendered, { displayMode: true });
    block.classList.add("math-block-rendered");
    block.classList.remove("math-block-active");
  });
}

function renderOrgEnvBlocks(root: HTMLElement): void {
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

function prepareStaticExportHTML(root: HTMLElement): void {
  renderInlineMathSources(root);
  renderDisplayMathBlocks(root);
  renderOrgEnvBlocks(root);
}

function protectMathML(html: string): { html: string; math: string[] } {
  const math: string[] = [];
  return {
    html: html.replace(/<math\b[\s\S]*?<\/math>/gi, (match) => {
      const index = math.length;
      math.push(DOMPurify.sanitize(`<div>${match}</div>`, {
        USE_PROFILES: { mathMl: true },
        ADD_ATTR: ["xmlns", "display"],
      }));
      return `\\uE000AARONNOTE_MATHML_${index}\\uE000`;
    }),
    math,
  };
}

function restoreMathML(html: string, math: readonly string[]): string {
  return html.replace(/\\uE000AARONNOTE_MATHML_(\d+)\\uE000/g, (_match, rawIndex: string) => {
    const index = Number(rawIndex);
    return math[index] ?? "";
  });
}

function restoreVisualSrcdoc(html: string, srcdocs: readonly string[]): string {
  return html.replace(/\sdata-aaronnote-protected-srcdoc="(\d+)"/g, (_match, rawIndex: string) => {
    const index = Number(rawIndex);
    const value = srcdocs[index];
    return value === undefined ? "" : ` srcdoc="${value}"`;
  });
}

function protectVisualSrcdocAttrs(root: HTMLElement): string[] {
  const srcdocs: string[] = [];
  root.querySelectorAll<HTMLIFrameElement>("iframe.aaronnote-visual-embed[srcdoc]").forEach((frame) => {
    const value = frame.getAttribute("srcdoc");
    if (value == null) return;
    const index = srcdocs.push(escapeAttrForProtectedSrcdoc(value)) - 1;
    frame.removeAttribute("srcdoc");
    frame.setAttribute("data-aaronnote-protected-srcdoc", String(index));
  });
  return srcdocs;
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
    html: html.replace(/<iframe\b(?=[^>]*\baaronnote-visual-embed\b)([^>]*)>/g, (_match, rawAttrs: string) => {
      const protectedAttrs: string[] = [];
      const remaining = rawAttrs.replace(/\s(allow|loading|referrerpolicy|sandbox)="([^"]*)"/g, (_attr, name: string, value: string) => {
        protectedAttrs.push(`${name}="${value}"`);
        return "";
      });
      if (protectedAttrs.length === 0) return `<iframe${rawAttrs}>`;
      const index = attrs.push(protectedAttrs.join(" ")) - 1;
      return `<iframe${remaining} data-aaronnote-protected-frame-attrs="${index}">`;
    }),
    attrs,
  };
}

function restoreVisualIframeAttrs(html: string, attrs: readonly string[]): string {
  return html.replace(/\sdata-aaronnote-protected-frame-attrs="(\d+)"/g, (_match, rawIndex: string) => {
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
      attr.name.startsWith("aria-")
    ) {
      el.removeAttribute(attr.name);
    }
  }
}

export function cleanEditorHTML(root: HTMLElement): string {
  const clone = root.cloneNode(true) as HTMLElement;
  prepareStaticExportHTML(clone);
  clone.querySelectorAll(
    [
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
    ].join(","),
  ).forEach((node) => node.remove());

  clone.querySelectorAll("pre.cb-diagram-rendered:not(.cb-diagram-error) > code")
    .forEach((node) => node.remove());
  clone.querySelectorAll("[hidden]").forEach((node) => node.remove());
  clone.querySelectorAll("*").forEach(stripAttrs);
  stripAttrs(clone);
  const protectedSrcdocs = protectVisualSrcdocAttrs(clone);
  const protectedHtml = protectMathML(clone.innerHTML);
  const protectedFrameAttrs = protectVisualIframeAttrs(protectedHtml.html);
  const sanitized = DOMPurify.sanitize(protectedFrameAttrs.html, {
    USE_PROFILES: { html: true, svg: true, mathMl: true },
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|file|zotero|roam|aaronnote-asset):|[#/]|\.{0,2}\/|[A-Za-z0-9._~!$&'()*+,;=@%-]+(?:[/?#]|$))/i,
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
      "data-aaronnote-math-block",
      "data-aaronnote-image-align",
      "data-aaronnote-image-wrap",
      "data-aaronnote-visual-kind",
      "data-aaronnote-dom-src-index",
      "data-aaronnote-dom-srcdoc-index",
      "data-aaronnote-protected-srcdoc",
      "data-aaronnote-protected-frame-attrs",
      "data-aaronnote-cell-command",
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
