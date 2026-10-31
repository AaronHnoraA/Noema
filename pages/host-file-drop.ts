/**
 * Files dragged from the system onto a Noema page.
 *
 * Unless the page takes the drag, WebKit navigates the view to the dropped
 * file and the page is gone.  The editor's own drop handler runs first, on its
 * content element, and links the files where they land; everywhere else a file
 * drop does nothing.  Every page installs this with its keyboard contract.
 */
function carriesFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

export function installFileDropGuard(target: EventTarget = window): () => void {
  const refuse = (event: Event) => {
    if (carriesFiles(event as DragEvent)) event.preventDefault();
  };
  target.addEventListener("dragover", refuse);
  target.addEventListener("drop", refuse);
  return () => {
    target.removeEventListener("dragover", refuse);
    target.removeEventListener("drop", refuse);
  };
}
