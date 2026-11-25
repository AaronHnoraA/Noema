import { writeSystemClipboard } from "../../../../system-clipboard.ts";

export type LocateDocumentView = (group: HTMLElement) => number | null;
export type ReadDocumentViewSource = (position: number) => string | undefined;

function sourceFallback(group: HTMLElement): string {
  return group.querySelector<HTMLTemplateElement>(":scope > template[data-document-source-body]")?.content.textContent ?? "";
}

export function readDocumentSource(group: HTMLElement, from: number | null, read: ReadDocumentViewSource): string {
  return (from === null ? undefined : read(from)) ?? sourceFallback(group);
}

const copyControls = new WeakSet<HTMLButtonElement>();

export function connectDocumentSourceCopy(root: HTMLElement, locate: LocateDocumentView, read: ReadDocumentViewSource): void {
  for (const button of root.querySelectorAll<HTMLButtonElement>("button[data-document-source-copy]")) {
    const group = button.closest<HTMLElement>("[data-view-source]");
    if (!group || copyControls.has(button)) continue;
    copyControls.add(button);
    button.addEventListener("click", async () => {
      const copied = await writeSystemClipboard(readDocumentSource(group, locate(group), read));
      if (button.isConnected) button.textContent = copied ? "Copied" : "Could not copy";
    });
  }
}
