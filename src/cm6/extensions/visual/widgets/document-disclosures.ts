import type { EditorView } from "@codemirror/view";
import { preserveEditorViewport } from "../../../viewport-stability.ts";
import { disconnectDocumentTableViews } from "../../../../document-table-view.ts";
import { documentViewState, rememberDocumentView } from "./document-view-state.ts";

const connectedGroups = new WeakSet<HTMLElement>();

export function connectDocumentDisclosures(root: HTMLElement, view: EditorView, hydrate: (body: HTMLElement) => void, locate: (group: HTMLElement) => number | null): void {
  const groups = root.querySelectorAll<HTMLElement>(".noema-document-disclosure[data-view-kind='details'], .noema-document-accordion[data-view-source]");
  for (const group of groups) {
    if (connectedGroups.has(group)) continue;
    connectedGroups.add(group);
    const items = group instanceof HTMLDetailsElement ? [group] : [...group.querySelectorAll<HTMLDetailsElement>(":scope > details[data-disclosure-item]")];
    const entries = items.map((item) => ({
      item,
      summary: item.querySelector<HTMLElement>(":scope > summary"),
      body: item.querySelector<HTMLElement>(":scope > .noema-disclosure-body"),
      template: item.querySelector<HTMLTemplateElement>(":scope > template[data-view-content]"),
    }));
    const authored = items.flatMap((item, index) => item.open ? [index] : []);
    if (group.parentElement?.parentElement === root && root.dataset.orgEnvKind === "accordion") {
      for (const { item, body } of entries) {
        if (body && item.dataset.viewOffset !== undefined) body.dataset.cmSourceOffset = item.dataset.viewOffset;
      }
    }
    const single = group.dataset.accordionSingle === "true";
    let opened = new Set<number>();

    function show(indexes: readonly number[]): void {
      opened = new Set(indexes);
      entries.forEach(({ item, body, template }, index) => {
        const open = opened.has(index);
        item.open = open;
        if (!body || !template) return;
        if (open && !body.hasChildNodes()) {
          body.append(template.content.cloneNode(true));
          hydrate(body);
        } else if (!open && body.hasChildNodes()) {
          disconnectDocumentTableViews(body);
          body.replaceChildren();
        }
      });
    }

    const initialize = () => {
      if (!view.dom.contains(group)) return;
      const position = locate(group);
      const choice = position === null ? undefined : view.state.field(documentViewState, false)?.get(position);
      show(typeof choice === "object" && "filter" in choice ? choice.filter((index) => index < items.length) : authored);
    };
    if (view.dom.contains(group)) initialize();
    else queueMicrotask(initialize);

    entries.forEach(({ summary }, index) => summary?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const indexes = opened.has(index) ? [...opened].filter((item) => item !== index)
        : single ? [index] : [...opened, index];
      const position = locate(group);
      const change = () => {
        show(indexes);
        if (position !== null) rememberDocumentView(view, position, indexes);
      };
      if (position === null) change();
      else preserveEditorViewport(view, change, position);
    }));
  }
}
