export type AaronnoteHostMode = "emacs" | "desktop" | "server";

export type AaronnoteHostCapabilities = {
  /** macOS WebKit/xwidget needs shared renderer focus parking when idle. */
  focusQuiescence?: boolean;
};

export function hostMode(): AaronnoteHostMode {
  const injected = String(
    (window as Window & { __aaronnoteHostMode?: string }).__aaronnoteHostMode || "",
  ).toLowerCase();
  if (injected === "desktop") return "desktop";
  if (injected === "server") return "server";
  try {
    return new URL(window.location.href).searchParams.get("host") === "desktop"
      ? "desktop"
      : "emacs";
  } catch {
    return "emacs";
  }
}

export function focusQuiescenceEnabled(): boolean {
  const capabilities = (window as Window & {
    __aaronnoteHostCapabilities?: AaronnoteHostCapabilities;
  }).__aaronnoteHostCapabilities;
  return capabilities?.focusQuiescence === true;
}

export function standaloneMode(): boolean {
  return hostMode() === "desktop";
}

export function serverMode(): boolean {
  return hostMode() === "server";
}

export function sourceEditorName(): "VS Code" | "Emacs" | "Source editor" {
  if (serverMode()) return "Source editor";
  return standaloneMode() ? "VS Code" : "Emacs";
}
