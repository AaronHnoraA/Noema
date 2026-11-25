import type { EditorView } from "@codemirror/view";
import { renderHighlightedCode } from "../../../../code-highlight-dom.ts";
import { writeSystemClipboard } from "../../../../system-clipboard.ts";
import { preserveEditorViewport } from "../../../viewport-stability.ts";
import { documentViewState, rememberDocumentView } from "./document-view-state.ts";

export const DEMO_TEXT_SELECTOR = ".noema-demo-code";
const connected = new WeakSet<HTMLElement>();

export function documentWindowScrollbar(event: Event): boolean {
  const body = event.target;
  if (!(event instanceof MouseEvent) || !(body instanceof HTMLElement) || !body.matches(".noema-window-body")) return false;
  const bounds = body.getBoundingClientRect();
  const unitX = bounds.width / body.offsetWidth;
  const unitY = bounds.height / body.offsetHeight;
  const left = bounds.left + body.clientLeft * unitX;
  const top = bounds.top + body.clientTop * unitY;
  return (body.scrollHeight > body.clientHeight && (event.clientX < left || event.clientX >= left + body.clientWidth * unitX))
    || (body.scrollWidth > body.clientWidth && (event.clientY < top || event.clientY >= top + body.clientHeight * unitY));
}

export function connectDocumentDemonstrations(
  root: HTMLElement,
  view: EditorView,
  locate: (group: HTMLElement) => number | null,
  sourceAt: (position: number) => string | undefined,
): void {
  for (const group of root.querySelectorAll<HTMLElement>('.noema-document-demo[data-view-kind="demo"]')) {
    if (connected.has(group)) continue;
    const sourcePanel = group.querySelector<HTMLElement>(":scope > .noema-demo-source");
    const control = group.querySelector<HTMLButtonElement>(":scope > .noema-demo-footer > [data-demo-toggle]");
    const copy = group.querySelector<HTMLButtonElement>(":scope > .noema-demo-footer > [data-demo-copy]");
    const fallback = group.querySelector<HTMLTemplateElement>(":scope > template[data-demo-fallback]");
    if (!sourcePanel || !control || !copy) continue;
    connected.add(group);
    const authored = group.dataset.demoOpen === "true";
    const read = (from: number | null) => (from === null ? undefined : sourceAt(from)) ?? fallback?.content.textContent ?? "";
    const show = (open: boolean, from: number | null) => {
      control.setAttribute("aria-expanded", String(open));
      sourcePanel.hidden = !open;
      if (!open) {
        sourcePanel.replaceChildren();
        return;
      }
      if (sourcePanel.firstChild) return;
      const pre = group.ownerDocument.createElement("pre");
      pre.className = "noema-demo-code";
      const code = group.ownerDocument.createElement("code");
      const source = read(from);
      if (source.length < 12_000) renderHighlightedCode(code, source, "markdown");
      else code.textContent = source;
      pre.append(code);
      sourcePanel.append(pre);
    };
    const initialize = () => {
      if (!view.dom.contains(group)) return;
      const from = locate(group);
      const choice = from === null ? undefined : view.state.field(documentViewState, false)?.get(from);
      show(typeof choice === "number" ? choice === 1 : authored, from);
    };
    if (view.dom.contains(group)) initialize();
    else queueMicrotask(initialize);

    control.addEventListener("click", (event) => {
      event.stopPropagation();
      const from = locate(group);
      const open = sourcePanel.hidden === true;
      const toggle = () => {
        show(open, from);
        if (from !== null) rememberDocumentView(view, from, Number(open));
      };
      if (from === null) toggle();
      else preserveEditorViewport(view, toggle, from);
    });
    copy.addEventListener("click", async () => {
      const copied = await writeSystemClipboard(read(locate(group)));
      if (copy.isConnected) copy.textContent = copied ? "Copied" : "Could not copy";
    });
  }
}
