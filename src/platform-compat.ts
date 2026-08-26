/** Neutral renderer platform seam shared by browser, Emacs/xwidget, and Electron. */

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
