import type { EditorView } from "@codemirror/view";
import { api, type ProjectTreeEntry } from "../../../../../pages/api-client.ts";
import { preserveEditorViewport } from "../../../viewport-stability.ts";
import { currentNotePath, loadWhenVisible } from "./document-excerpts.ts";
import { connectDocumentTreeKeyboard } from "./document-trees.ts";
import { documentViewState, rememberDocumentView } from "./document-view-state.ts";

const connected = new WeakSet<HTMLElement>();

export function connectProjectTrees(root: ParentNode, view: EditorView, locate: (group: HTMLElement) => number | null): void {
  for (const group of root.querySelectorAll<HTMLElement>(".noema-project-tree[data-project-path]")) {
    if (connected.has(group)) continue;
    connected.add(group);
    const output = group.querySelector<HTMLElement>(".noema-project-tree-output");
    const path = group.querySelector<HTMLElement>(".noema-project-tree-path");
    const status = group.querySelector<HTMLElement>(".noema-excerpt-status");
    const fallback = group.querySelector<HTMLElement>(".noema-excerpt-fallback");
    const refresh = group.querySelector<HTMLButtonElement>("[data-project-refresh]");
    if (!output || !path || !status || !fallback || !refresh) continue;
    const data = group.dataset;
    const options = { path: data.projectPath, depth: data.projectDepth, ignore: data.projectIgnore };
    const openDepth = Number(data.projectOpenDepth ?? 1);
    const defaultDepth = Number.isSafeInteger(openDepth) && openDepth >= 0 ? openDepth : 1;
    let choices: ReadonlyMap<string, boolean> = new Map();

    const load = async () => {
      if (!group.isConnected || refresh.disabled) return;
      const notePath = currentNotePath();
      refresh.disabled = true;
      status.hidden = false;
      status.textContent = "Loading project tree…";
      try {
        const data = await api.documentAssets.projectTree({ notePath, ...options });
        if (!group.isConnected || notePath !== currentNotePath()) return;
        const position = locate(group);
        const remembered = position === null ? undefined : view.state.field(documentViewState, false)?.get(position);
        if (typeof remembered === "object" && "folders" in remembered) choices = remembered.folders;
        const draw = (entries: ProjectTreeEntry[], depth: number): HTMLUListElement => {
          const list = document.createElement("ul");
          list.className = "noema-tree-list";
          list.setAttribute("role", "list");
          for (const entry of entries) {
            const item = document.createElement("li");
            const name = document.createElement("span");
            name.className = "noema-tree-name";
            name.dataset.treeType = entry.directory ? "directory" : "file";
            if (entry.directory) name.textContent = entry.label;
            else {
              const button = document.createElement("button");
              button.type = "button";
              button.dataset.treeFile = entry.key;
              button.textContent = entry.label;
              button.addEventListener("click", () => {
                if (currentNotePath() !== notePath) return;
                void api.emacs.open({ file: entry.file }).catch((error: unknown) => {
                  status.hidden = false;
                  status.textContent = error instanceof Error ? error.message : "The file could not be opened.";
                });
              });
              name.append(button);
            }
            if (entry.children.length) {
              const key = JSON.stringify([notePath, options.path, entry.key]);
              const details = document.createElement("details");
              details.dataset.treeDirectory = key;
              details.open = choices.get(key) ?? depth < defaultDepth;
              const summary = document.createElement("summary");
              summary.append(name);
              summary.addEventListener("click", (event) => {
                event.preventDefault();
                event.stopPropagation();
                const position = locate(group);
                const change = () => {
                  details.open = !details.open;
                  choices = new Map(choices).set(key, details.open);
                  if (position !== null) rememberDocumentView(view, position, { file: undefined, folders: choices });
                  view.requestMeasure();
                };
                if (position === null) change();
                else preserveEditorViewport(view, change, position);
              });
              details.append(summary, draw(entry.children, depth + 1));
              item.append(details);
            } else {
              const row = document.createElement("div");
              row.className = "noema-tree-row";
              row.append(name);
              item.append(row);
            }
            list.append(item);
          }
          return list;
        };
        output.replaceChildren(draw(data.entries, 0));
        path.textContent = data.label;
        fallback.hidden = true;
        status.textContent = data.truncated ? "Project preview limited to 150 entries." : data.entries.length ? "" : "No files in this view.";
        status.hidden = !status.textContent;
      } catch (error) {
        if (!group.isConnected || notePath !== currentNotePath()) return;
        output.replaceChildren();
        fallback.hidden = false;
        status.textContent = error instanceof Error ? error.message : "The project directory could not be read.";
      } finally {
        refresh.disabled = false;
        if (group.isConnected) view.requestMeasure();
      }
    };
    connectDocumentTreeKeyboard(output);
    refresh.addEventListener("click", () => { void load(); });
    loadWhenVisible(group, () => { void load(); });
  }
}
