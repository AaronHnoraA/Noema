export type AaronnoteHostMode = "emacs" | "desktop";

export function hostMode(): AaronnoteHostMode {
  const injected = String(
    (window as Window & { __aaronnoteHostMode?: string }).__aaronnoteHostMode || "",
  ).toLowerCase();
  if (injected === "desktop") return "desktop";
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

export function sourceEditorName(): "VS Code" | "Emacs" {
  return standaloneMode() ? "VS Code" : "Emacs";
}
