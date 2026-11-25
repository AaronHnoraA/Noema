import type { EditorView } from "@codemirror/view";
import { documentDiffModes } from "../../../../document-diff.ts";
import { writeSystemClipboard } from "../../../../system-clipboard.ts";
import { preserveEditorViewport } from "../../../viewport-stability.ts";
import { documentViewState, rememberDocumentView } from "./document-view-state.ts";

const connected = new WeakSet<HTMLElement>();
const locations = new WeakMap<HTMLElement, () => number | null>();

export function documentDiffSourceAt(view: EditorView, target: EventTarget | null): { from: number; anchor: number } | null {
  const element = target instanceof Element ? target : target instanceof Text ? target.parentElement : null;
  const cell = element?.closest(".noema-diff-other-number")
    ? element.closest(".noema-diff-row")?.querySelector<HTMLElement>("[data-diff-side='after'][data-diff-line]")
    : element?.closest<HTMLElement>(".noema-diff-cell[data-diff-line]");
  const group = cell?.closest<HTMLElement>(".noema-document-diff");
  const from = group ? locations.get(group)?.() : null;
  if (from == null || !cell) return null;
  const doc = view.state.doc;
  const number = doc.lineAt(from).number + 1 + Number(cell.dataset.diffLine);
  if (!Number.isInteger(number) || number < 1 || number > doc.lines) return null;
  const line = doc.line(number);
  if (line.text.trimStart() !== cell.querySelector("code")?.textContent?.trimStart()) return null;
  return { from, anchor: line.from };
}

export function connectDocumentDiffs(root: HTMLElement, view: EditorView, locate: (group: HTMLElement) => number | null): void {
  for (const group of root.querySelectorAll<HTMLElement>(".noema-document-diff[data-view-source]")) {
    if (connected.has(group)) continue;
    connected.add(group);
    locations.set(group, () => locate(group));
    const buttons = [...group.querySelectorAll<HTMLButtonElement>(".noema-diff-modes > button[data-diff-mode]")];
    const status = group.querySelector<HTMLElement>(".noema-diff-status");
    status?.setAttribute("role", "status");
    const select = (mode: string) => {
      group.dataset.diffMode = mode;
      for (const button of buttons) button.setAttribute("aria-pressed", String(button.dataset.diffMode === mode));
    };
    const initialize = () => {
      if (!view.dom.contains(group)) return;
      const from = locate(group);
      const saved = from === null ? undefined : view.state.field(documentViewState, false)?.get(from);
      const mode = typeof saved === "number" ? documentDiffModes[saved] : undefined;
      select(mode ?? group.dataset.diffMode ?? "auto");
    };
    if (view.dom.contains(group)) initialize();
    else queueMicrotask(initialize);

    for (const button of buttons) button.addEventListener("click", () => {
      const index = documentDiffModes.findIndex((mode) => mode === button.dataset.diffMode);
      if (index < 0) return;
      const from = locate(group);
      const change = () => {
        select(documentDiffModes[index]!);
        if (from !== null) rememberDocumentView(view, from, index);
      };
      if (from === null) change();
      else preserveEditorViewport(view, change, from);
    });

    for (const button of group.querySelectorAll<HTMLButtonElement>(".noema-diff-labels button[data-diff-copy]")) {
      const label = button.previousElementSibling?.textContent || "";
      button.setAttribute("aria-label", `Copy ${label}`);
      button.addEventListener("click", async () => {
        const side = button.dataset.diffCopy === "before" ? "before" : "after";
        const template = group.querySelector<HTMLTemplateElement>(`:scope > template[data-diff-copy='${side}']`);
        if (!template) return;
        const copied = await writeSystemClipboard(template.content.textContent ?? "");
        if (status && group.isConnected) status.textContent = copied ? "Copied" : "Could not copy";
      });
    }
  }
}
