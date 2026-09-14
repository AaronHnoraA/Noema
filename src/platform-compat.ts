/** Neutral platform seam shared by Emacs/xwidget and read-only browser pages. */

export type NoemaPlatform = "darwin" | "win32" | "linux" | "unknown";

/**
 * Classify one platform string.
 *
 * Darwin has to be tested before Windows: `"darwin".includes("win")` is true,
 * so a `win` check that runs first claims every Apple platform string that
 * spells out the kernel name — and `navigator.platform` does, both under the
 * Emacs xwidget host and in test environments (`"X11; Darwin arm64"`). Getting
 * this backwards silently swaps the primary modifier, so Cmd+click stops
 * opening links on macOS.
 */
function classifyPlatformHint(value: string): NoemaPlatform | null {
  const hint = value.toLowerCase();
  if (!hint) return null;
  if (hint.includes("mac") || hint.includes("darwin") || hint.includes("iphone") || hint.includes("ipad")) {
    return "darwin";
  }
  if (hint.includes("linux") || hint.includes("x11") || hint.includes("bsd")) return "linux";
  if (hint.includes("win")) return "win32";
  return null;
}

export function detectNoemaPlatform(explicit = ""): NoemaPlatform {
  const stated = classifyPlatformHint(String(explicit));
  if (stated) return stated;
  if (typeof navigator !== "undefined") {
    const userAgentData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
    const hinted = classifyPlatformHint(String(userAgentData?.platform || navigator.platform || ""));
    if (hinted) return hinted;
  }
  return "unknown";
}

export const isMacPlatform = (platform: NoemaPlatform | string = detectNoemaPlatform()): boolean => (
  detectNoemaPlatform(platform) === "darwin"
);

export function noemaPlatformLabels(platform: NoemaPlatform | string = detectNoemaPlatform()): {
  primaryModifier: string;
  alternateModifier: string;
  fileManager: string;
  trash: string;
} {
  const detected = detectNoemaPlatform(platform);
  if (detected === "win32") {
    return {
      primaryModifier: "Ctrl",
      alternateModifier: "Alt",
      fileManager: "File Explorer",
      trash: "Recycle Bin",
    };
  }
  return {
    primaryModifier: detected === "darwin" ? "⌘" : "Ctrl",
    alternateModifier: detected === "darwin" ? "Option" : "Alt",
    fileManager: detected === "darwin" ? "Finder" : "file manager",
    trash: "Trash",
  };
}

export function markdownDropDisposition(
  files: Iterable<string>,
  forceAttachment = false,
): { type: "open" | "insert"; paths: string[] } {
  const paths = Array.from(files)
    .map((file) => String(file || "").trim())
    .filter(Boolean);
  const allMarkdown = paths.length > 0 && paths.every((file) => /\.(?:md|markdown)$/i.test(file));
  return !forceAttachment && allMarkdown
    ? { type: "open", paths }
    : { type: "insert", paths };
}

export function primaryModifierDown(
  event: Pick<KeyboardEvent | MouseEvent, "metaKey" | "ctrlKey">,
  platform: NoemaPlatform | string = detectNoemaPlatform(),
): boolean {
  const detected = detectNoemaPlatform(platform);
  if (detected === "unknown") return event.metaKey !== event.ctrlKey;
  return isMacPlatform(detected)
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
}

export function onlyControlDown(
  event: Pick<KeyboardEvent | MouseEvent, "metaKey" | "ctrlKey">,
): boolean {
  return event.ctrlKey && !event.metaKey;
}

export function onlyMetaDown(
  event: Pick<KeyboardEvent | MouseEvent, "metaKey" | "ctrlKey">,
): boolean {
  return event.metaKey && !event.ctrlKey;
}
