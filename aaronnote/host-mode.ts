export type AaronnoteHostMode = "emacs" | "desktop" | "server";

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
