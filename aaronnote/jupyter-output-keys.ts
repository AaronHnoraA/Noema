/** Keyboard commands for a selected output card. Native controls keep their keys. */
export type OutputShortcut = "previous" | "next" | "fold" | "expand" | "source" | "popout" | "help";

const INTERACTIVE = [
  "button", "a[href]", "input", "textarea", "select", "summary", "canvas", "math-field",
  "[contenteditable]:not([contenteditable='false'])", "[role='button']",
  "[role='menuitem']", "[role='option']", "[role='application']",
  "[tabindex]:not(.noema-jupyter-cell):not([tabindex='-1'])", ".jupyter-widgets",
].join(",");

function plainEnter(event: KeyboardEvent): boolean {
  return /^(?:Enter|Return|RET|CR)$/i.test(event.key) || event.code === "NumpadEnter";
}

/** Enter closes the full-output dialog, except inside a control in its body. */
export function outputDialogEnterCloses(event: KeyboardEvent, body: Element): boolean {
  if (event.defaultPrevented || event.isComposing
      || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey
      || !plainEnter(event)) return false;
  const target = event.target;
  return !(target instanceof Element && body.contains(target) && target.closest(INTERACTIVE));
}

export function outputShortcut(event: KeyboardEvent): OutputShortcut | null {
  if (event.defaultPrevented || event.isComposing) return null;
  const target = event.target;
  if (target instanceof Element && target.closest(INTERACTIVE)) return null;
  const enter = plainEnter(event);
  if (event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && enter) return "source";
  if (event.key === "?" && !event.metaKey && !event.ctrlKey && !event.altKey) return "help";
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null;
  if (enter) return "popout";
  if (event.code === "Space") return "expand";
  switch (event.key) {
    case "ArrowUp": return "previous";
    case "ArrowDown": return "next";
    case "Tab": return "fold";
    case " ":
    case "Space":
    case "Spacebar": return "expand";
    default: return null;
  }
}
