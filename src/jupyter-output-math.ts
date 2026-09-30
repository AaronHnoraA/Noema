// KaTeX typesetting for Jupyter and agent Markdown outputs.
import type { IRenderMime } from "@jupyterlab/rendermime";
import { renderMathHTML } from "./math-render.ts";

function stripMathDelimiters(raw: string): { body: string; displayMode: boolean } | null {
  const text = raw.trim();
  if (text.startsWith("\\[") && text.endsWith("\\]")) return { body: text.slice(2, -2), displayMode: true };
  if (text.startsWith("\\(") && text.endsWith("\\)")) return { body: text.slice(2, -2), displayMode: false };
  if (text.startsWith("$$") && text.endsWith("$$")) return { body: text.slice(2, -2), displayMode: true };
  if (text.length > 1 && text.startsWith("$") && text.endsWith("$")) return { body: text.slice(1, -1), displayMode: false };
  return null;
}

export function renderKatexInto(host: HTMLElement, raw: string): void {
  const stripped = stripMathDelimiters(raw) ?? { body: raw.trim(), displayMode: false };
  const { html, error } = renderMathHTML(stripped.body.trim(), { displayMode: stripped.displayMode });
  if (error || !html) {
    host.textContent = raw;
    return;
  }
  const div = document.createElement("div");
  div.className = "cm-ceil-output-latex";
  if (stripped.displayMode) div.dataset.display = "true";
  div.innerHTML = html;
  host.replaceChildren(div);
}

// JupyterLab restores $...$ and $$...$$ after its Markdown parser runs.  Its
// stock typesetter expects MathJax to pick them up; our KaTeX typesetter must
// recognize them here as well as Noema's \(...\) and \[...\] delimiters.
const INLINE_MATH_RE = /\\\((.+?)\\\)|\\\[([\s\S]+?)\\\]|\$\$([\s\S]+?)\$\$|\$((?:\\.|[^\\$\n])+?)\$(?!\d)/g;

export class KatexTypesetter implements IRenderMime.ILatexTypesetter {
  typeset(host: HTMLElement): void {
    // text/latex renderer sets the whole element text to a single delimited
    // expression; render it as one block.
    const raw = (host.textContent ?? "").trim();
    if (host.childElementCount === 0 && stripMathDelimiters(raw)) {
      renderKatexInto(host, raw);
      return;
    }
    // Otherwise scan text nodes for inline/display math (markdown/html output).
    this.scanTextNodes(host);
  }

  private scanTextNodes(root: HTMLElement): void {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (parent.closest("script,style,code,pre,.katex,.cm-ceil-output-latex")) return NodeFilter.FILTER_REJECT;
        INLINE_MATH_RE.lastIndex = 0;
        return INLINE_MATH_RE.test(node.nodeValue ?? "") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    const targets: Text[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) targets.push(node as Text);
    for (const text of targets) this.replaceMathInTextNode(text);
  }

  private replaceMathInTextNode(node: Text): void {
    const source = node.nodeValue ?? "";
    INLINE_MATH_RE.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0;
    let match: RegExpExecArray | null;
    while ((match = INLINE_MATH_RE.exec(source))) {
      if (match.index > last) frag.append(source.slice(last, match.index));
      const inline = match[1] ?? match[4];
      const display = match[2] ?? match[3];
      const body = inline ?? display ?? "";
      const { html, error } = renderMathHTML(body.trim(), { displayMode: display != null });
      if (error || !html) {
        frag.append(match[0]);
      } else {
        const span = document.createElement(display != null ? "div" : "span");
        span.className = "cm-ceil-output-latex";
        if (display != null) span.dataset.display = "true";
        span.innerHTML = html;
        frag.append(span);
      }
      last = match.index + match[0].length;
    }
    if (last < source.length) frag.append(source.slice(last));
    node.replaceWith(frag);
  }
}
