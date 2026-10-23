export type NoemaHostMode = "emacs" | "server";

export type NoemaHostCapabilities = {
  /** macOS WebKit/xwidget needs shared renderer focus parking when idle. */
  focusQuiescence?: boolean;
};

export function hostMode(): NoemaHostMode {
  const injected = String(
    (window as Window & { __noemaHostMode?: string }).__noemaHostMode || "",
  ).toLowerCase();
  if (injected === "server") return "server";
  return "emacs";
}

export function focusQuiescenceEnabled(): boolean {
  const capabilities = (window as Window & {
    __noemaHostCapabilities?: NoemaHostCapabilities;
  }).__noemaHostCapabilities;
  return capabilities?.focusQuiescence === true;
}

export function serverMode(): boolean {
  return hostMode() === "server";
}

export function sourceEditorName(): "VS Code" | "Emacs" | "Source editor" {
  if (serverMode()) return "Source editor";
  return "Emacs";
}
