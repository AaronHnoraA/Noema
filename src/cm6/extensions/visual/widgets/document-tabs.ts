import { MapMode, StateEffect, StateField, Transaction } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { preserveEditorViewport, revealInHorizontalStrip } from "../../../viewport-stability.ts";
import { disconnectDocumentTableViews } from "../../../../document-table-view.ts";

const tabSelection = StateEffect.define<{ from: number; index: number }>();

export const documentTabState = StateField.define<ReadonlyMap<number, number>>({
  create: () => new Map(),
  update(value, transaction) {
    const changed = transaction.effects.filter((effect) => effect.is(tabSelection));
    if (!changed.length && (!transaction.docChanged || !value.size)) return value;
    const next = new Map<number, number>();
    for (const [position, index] of value) {
      const mapped = transaction.changes.mapPos(position, 1, MapMode.TrackDel);
      if (mapped !== null) next.set(mapped, index);
    }
    for (const effect of changed) {
      if (!effect.is(tabSelection)) continue;
      const { from, index } = effect.value;
      next.set(from, index);
    }
    return next;
  },
});

let nextGroupId = 0;

function numberTabGroups(container: ParentNode, counts = new Map<string, number>()): void {
  for (const node of container.querySelectorAll<HTMLElement>(".noema-document-tabs[data-tab-source], template[data-tab-content]")) {
    if (node instanceof HTMLTemplateElement) {
      numberTabGroups(node.content, counts);
    } else {
      const key = node.dataset.tabSource!;
      const index = counts.get(key) ?? 0;
      node.dataset.tabSourceOccurrence = String(index);
      counts.set(key, index + 1);
    }
  }
}

export function connectDocumentTabViews(root: HTMLElement, view: EditorView, hydrate: (panel: HTMLElement) => void, locate: (group: HTMLElement) => number | null): void {
  numberTabGroups(root);

  function connectGroups(container: HTMLElement): void {
    const groups = container.querySelectorAll<HTMLElement>(".noema-document-tabs");
    groups.forEach((group) => {
      const strip = group.querySelector<HTMLElement>(":scope > .noema-tab-navigation > .noema-tab-strip");
      const body = group.querySelector<HTMLElement>(":scope > .noema-tab-body");
      const templates = [...group.querySelectorAll<HTMLTemplateElement>(":scope > template[data-tab-content]")];
      if (!strip || !body || templates.length < 2) return;
      const buttons = [...strip.querySelectorAll<HTMLButtonElement>("button[data-tab-index]")];
      const previous = group.querySelector<HTMLButtonElement>(":scope > .noema-tab-navigation > [data-move='-1']");
      const next = group.querySelector<HTMLButtonElement>(":scope > .noema-tab-navigation > [data-move='1']");
      previous?.setAttribute("aria-label", "Previous page");
      next?.setAttribute("aria-label", "Next page");
      strip.setAttribute("aria-label", "Document pages");
      const id = `noema-document-tabs-${++nextGroupId}`;
      const panels = buttons.map((button, index) => {
        const panel = document.createElement("div");
        button.id = `${id}-tab-${index}`;
        button.setAttribute("role", "tab");
        button.setAttribute("aria-controls", `${id}-page-${index}`);
        panel.className = "noema-tab-pane";
        panel.id = `${id}-page-${index}`;
        panel.setAttribute("role", "tabpanel");
        panel.setAttribute("aria-labelledby", button.id);
        panel.tabIndex = 0;
        const offset = templates[index]?.dataset.tabOffset;
        if (offset !== undefined && group.parentElement?.parentElement === root
            && root.dataset.orgEnvKind === group.dataset.tabKind) panel.dataset.cmSourceOffset = offset;
        body.append(panel);
        return panel;
      });
      let active = -1;
      function show(index: number): void {
        if (index === active || index < 0 || index >= buttons.length) return;
        if (active >= 0) {
          const old = panels[active]!;
          disconnectDocumentTableViews(old);
          old.replaceChildren();
        }
        active = index;
        panels.forEach((panel, i) => { panel.hidden = i !== index; });
        buttons.forEach((button, i) => {
          button.setAttribute("aria-selected", String(i === index));
          button.tabIndex = i === index ? 0 : -1;
        });
        if (previous) previous.disabled = index === 0;
        if (next) next.disabled = index === buttons.length - 1;
        const panel = panels[index]!;
        panel.append(templates[index]!.content.cloneNode(true));
        connectGroups(panel);
        hydrate(panel);
      }
      function select(index: number, focus = false): void {
        if (index < 0 || index >= buttons.length) return;
        const from = locate(group);
        const change = () => {
          show(index);
          if (from !== null) view.dispatch({
            effects: tabSelection.of({ from, index }),
            annotations: Transaction.addToHistory.of(false),
          });
          if (focus) {
            const button = buttons[index]!;
            button.focus({ preventScroll: true });
            revealInHorizontalStrip(strip!, button);
          }
        };
        if (from === null) change();
        else preserveEditorViewport(view, change, from);
      }
      const initialize = () => {
        if (!view.dom.contains(group)) return;
        const from = locate(group);
        const remembered = from === null ? undefined : view.state.field(documentTabState, false)?.get(from);
        show(remembered != null && remembered < buttons.length ? remembered : Number(group.dataset.tabSelected));
      };
      // A reused widget can carry old source offsets until CodeMirror puts it
      // back in the document view. Resolve the selection before mounting media.
      if (view.dom.contains(group)) initialize();
      else queueMicrotask(initialize);
      buttons.forEach((button, index) => button.addEventListener("click", () => select(index)));
      previous?.addEventListener("click", () => select(active - 1, true));
      next?.addEventListener("click", () => select(active + 1, true));
      strip.addEventListener("keydown", (event) => {
        let index: number;
        switch (event.key) {
          case "ArrowLeft": index = (active + buttons.length - 1) % buttons.length; break;
          case "ArrowRight": index = (active + 1) % buttons.length; break;
          case "Home": index = 0; break;
          case "End": index = buttons.length - 1; break;
          default: return;
        }
        event.preventDefault();
        event.stopPropagation();
        select(index, true);
      });
    });
  }

  connectGroups(root);
}
