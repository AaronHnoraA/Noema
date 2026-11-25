import type { EditorView } from "@codemirror/view";
import { api, type DocumentSymbolDetails } from "../../../../../pages/api-client.ts";
import { currentNotePath, loadWhenVisible } from "./document-excerpts.ts";

const connected = new WeakSet<HTMLElement>();

function symbolDetails(symbol: DocumentSymbolDetails): DocumentFragment {
  const fragment = document.createDocumentFragment();
  if (symbol.signature) {
    const signature = document.createElement("code");
    signature.className = "noema-symbol-signature";
    signature.textContent = symbol.signature;
    fragment.append(signature);
  }
  if (symbol.summary) {
    const summary = document.createElement("p");
    summary.textContent = symbol.summary;
    fragment.append(summary);
  }
  if (symbol.file || symbol.keys.length) {
    const metadata = document.createElement("div");
    metadata.className = "noema-symbol-metadata";
    if (symbol.file) {
      const file = document.createElement("code");
      file.textContent = symbol.file;
      metadata.append(file);
    }
    for (const key of symbol.keys) {
      const shortcut = document.createElement("kbd");
      shortcut.textContent = key;
      metadata.append(shortcut);
    }
    fragment.append(metadata);
  }
  return fragment;
}

export function connectDocumentSymbols(root: ParentNode, view: EditorView): void {
  for (const element of root.querySelectorAll<HTMLElement>(".noema-document-symbol[data-emacs-symbol]")) {
    if (connected.has(element)) continue;
    connected.add(element);
    const name = element.dataset.emacsSymbol!;
    const status = element.querySelector<HTMLElement>(".noema-excerpt-status");
    const fallback = element.querySelector<HTMLElement>(".noema-excerpt-fallback");
    const output = element.querySelector<HTMLElement>(".noema-symbol-output");
    const kind = element.querySelector<HTMLElement>(".noema-symbol-kind");
    const actions = element.querySelector<HTMLElement>(".noema-excerpt-actions");
    const definition = element.querySelector<HTMLButtonElement>("[data-symbol-definition]");
    const help = element.querySelector<HTMLButtonElement>("[data-symbol-help]");
    if (!status || !fallback || !output || !kind || !actions || !definition || !help) continue;
    actions.hidden = true;
    const showStatus = (message: string) => {
      status.textContent = message;
      status.hidden = !message;
      view.requestMeasure();
    };
    let resultNote: string | undefined;
    const stillOpen = (note: string) => element.isConnected && currentNotePath() === note;
    const open = (action: "help" | "definition") => {
      const note = resultNote;
      if (note === undefined || !stillOpen(note)) return;
      void api.documentAssets.openSymbol(name, action).then(() => {
        if (stillOpen(note)) showStatus("");
      }).catch((error: unknown) => {
        if (stillOpen(note)) showStatus(error instanceof Error ? error.message : "The symbol could not be opened.");
      });
    };
    help.addEventListener("click", () => open("help"));
    definition.addEventListener("click", () => open("definition"));
    const load = async () => {
      const note = currentNotePath();
      try {
        const symbol = await api.documentAssets.inspectSymbol(name);
        if (!stillOpen(note)) return;
        if (!symbol.found) {
          showStatus("Symbol is unavailable in this Emacs session.");
          return;
        }
        output.replaceChildren(symbolDetails(symbol));
        kind.textContent = symbol.kind;
        fallback.hidden = true;
        actions.hidden = false;
        definition.hidden = !symbol.file;
        delete element.dataset.symbolAwaiting;
        resultNote = note;
        showStatus("");
      } catch (error) {
        if (stillOpen(note)) showStatus(error instanceof Error ? error.message : "Emacs could not look up the symbol.");
      }
    };
    loadWhenVisible(element, () => { if (element.isConnected) void load(); });
  }
}
