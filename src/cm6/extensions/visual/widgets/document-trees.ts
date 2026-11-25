import type { EditorView } from "@codemirror/view";
import { writeSystemClipboard } from "../../../../system-clipboard.ts";
import { renderHighlightedCode } from "../../../../code-highlight-dom.ts";
import { preserveEditorViewport } from "../../../viewport-stability.ts";
import { documentViewState, rememberDocumentView } from "./document-view-state.ts";

const connected = new WeakSet<HTMLElement>();
export const CODE_TREE_TEXT_SELECTOR = ".noema-code-tree-preview pre";

export function connectDocumentTrees(root: HTMLElement, view: EditorView, locate: (group: HTMLElement) => number | null): void {
  for (const group of root.querySelectorAll<HTMLElement>(".noema-document-tree[data-view-source]")) {
    if (connected.has(group)) continue;
    connected.add(group);
    const tree = group.querySelector<HTMLElement>(":scope > .noema-code-tree-files") ?? group;
    const folders = [...tree.querySelectorAll<HTMLDetailsElement>("details[data-tree-directory]")];
    const files = [...tree.querySelectorAll<HTMLButtonElement>("button[data-tree-file]")];
    const snippets = [...group.querySelectorAll<HTMLTemplateElement>(":scope > template[data-tree-snippet]")];
    const path = group.querySelector<HTMLElement>(".noema-code-tree-path");
    const code = group.querySelector<HTMLElement>(".noema-code-tree-preview code");
    const copy = group.querySelector<HTMLButtonElement>("button[data-tree-copy]");
    const defaults = folders.map((folder) => ({
      folder, id: folder.dataset.treeDirectory!, open: folder.open,
    }));
    let selected = snippets.length ? 0 : -1;
    let drawn = -1;
    let folderChoices: ReadonlyMap<string, boolean> = new Map();

    const show = (file: number, folders: ReadonlyMap<string, boolean>) => {
      folderChoices = folders;
      for (const { folder, id, open } of defaults) folder.open = folders.get(id) ?? open;
      const snippet = snippets[file];
      if (!snippet || !code || !path) return;
      selected = file;
      if (drawn === file) return;
      drawn = file;
      const text = snippet.content.textContent ?? "";
      if (snippet.dataset.language && text.length < 12_000) renderHighlightedCode(code, text, snippet.dataset.language);
      else code.textContent = text;
      path.textContent = snippet.dataset.path || "";
      for (const button of files) button.setAttribute("aria-pressed", String(Number(button.dataset.treeFile) === selected));
      if (copy) {
        copy.textContent = "Copy";
        copy.setAttribute("aria-label", `Copy ${snippet.dataset.path || "file"}`);
      }
    };
    const update = (file: number, folders: ReadonlyMap<string, boolean>) => {
      const from = locate(group);
      const change = () => {
        show(file, folders);
        if (from !== null) rememberDocumentView(view, from, { file: snippets[file]?.dataset.path, folders });
      };
      if (from === null) change();
      else preserveEditorViewport(view, change, from);
    };

    const initialize = () => {
      if (!view.dom.contains(group)) return;
      const from = locate(group);
      const choice = from === null ? undefined : view.state.field(documentViewState, false)?.get(from);
      if (typeof choice === "object" && "folders" in choice) {
        const file = snippets.findIndex((snippet) => snippet.dataset.path === choice.file);
        show(file < 0 ? selected : file, choice.folders);
      } else show(selected, folderChoices);
    };
    if (view.dom.contains(group)) initialize();
    else queueMicrotask(initialize);

    for (const folder of folders) folder.querySelector(":scope > summary")?.addEventListener("click", (event) => {
      if (event.target instanceof Element && event.target.closest("a[href]")) return;
      event.preventDefault();
      event.stopPropagation();
      update(selected, new Map(folderChoices).set(folder.dataset.treeDirectory!, !folder.open));
    });
    for (const button of files) button.addEventListener("click", () => update(Number(button.dataset.treeFile), folderChoices));
    copy?.addEventListener("click", async () => {
      const file = selected;
      const snippet = snippets[file];
      if (!snippet) return;
      const copied = await writeSystemClipboard(snippet.content.textContent ?? "");
      if (copy.isConnected && file === selected) copy.textContent = copied ? "Copied" : "Could not copy";
    });

    tree.addEventListener("keydown", (event) => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const current = event.target;
      const controls = [...tree.querySelectorAll<HTMLElement>("summary, a[href], button[data-tree-file]")].filter((item) => {
        const branch = item.tagName === "SUMMARY" ? item.parentElement?.parentElement : item;
        return !branch?.closest("details:not([open])");
      });
      const index = current instanceof HTMLElement ? controls.indexOf(current) : -1;
      if (index < 0) return;
      const next = event.key === "Home" ? 0 : event.key === "End" ? controls.length - 1
        : Math.max(0, Math.min(controls.length - 1, index + (event.key === "ArrowUp" ? -1 : 1)));
      event.preventDefault();
      event.stopPropagation();
      controls[next]?.focus({ preventScroll: true });
      controls[next]?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
  }
}
