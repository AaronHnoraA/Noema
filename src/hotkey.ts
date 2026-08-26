import {
  detectNoemaPlatform,
  isMacPlatform,
  type NoemaPlatform,
} from "./platform-compat.ts";

export type HotKeyEvent = Pick<
  KeyboardEvent,
  "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
>;

export interface HotKeyMatchOptions {
  platform?: NoemaPlatform | string;
  /** Ignore modifiers not named by the shortcut. Exact matching is the default. */
  allowExtraModifiers?: boolean;
}

export interface ParsedHotKey {
  key: string;
  primary: boolean;
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

const KEY_ALIASES: Record<string, string> = {
  esc: "escape",
  escape: "escape",
  return: "enter",
  enter: "enter",
  space: " ",
  spacebar: " ",
  up: "arrowup",
  down: "arrowdown",
  left: "arrowleft",
  right: "arrowright",
  del: "delete",
  backspace: "backspace",
  plus: "+",
  minus: "-",
};

function normalizedKey(value: string): string {
  const key = value.trim().toLowerCase();
  return KEY_ALIASES[key] ?? key;
}

function splitHotKey(source: string): string[] {
  const symbolic = source.match(/^[⌃⌥⇧⌘]+/u)?.[0] || "";
  if (symbolic) return [...symbolic, source.slice(symbolic.length)].filter(Boolean);
  return source.replace(/-/g, "+").split("+").map((part) => part.trim()).filter(Boolean);
}

export function parseHotKey(source: string): ParsedHotKey | null {
  const parts = splitHotKey(String(source || ""));
  if (parts.length === 0) return null;
  const parsed: ParsedHotKey = {
    key: "",
    primary: false,
    meta: false,
    ctrl: false,
    alt: false,
    shift: false,
  };
  for (const part of parts) {
    const value = part.toLowerCase();
    if (part === "⌘" || /^(?:cmd|command|meta)$/u.test(value)) parsed.meta = true;
    else if (part === "⌃" || /^(?:ctrl|control)$/u.test(value)) parsed.ctrl = true;
    else if (part === "⌥" || /^(?:alt|option)$/u.test(value)) parsed.alt = true;
    else if (part === "⇧" || value === "shift") parsed.shift = true;
    else if (/^(?:mod|primary|cmdorctrl|commandorcontrol)$/u.test(value)) parsed.primary = true;
    else if (parsed.key) return null;
    else parsed.key = normalizedKey(part);
  }
  return parsed.key ? parsed : null;
}

function eventKey(event: HotKeyEvent): string {
  const key = normalizedKey(event.key || "");
  if (key && key !== "unidentified") return key;
  return normalizedKey(String(event.code || "").replace(/^Key/u, "").replace(/^Digit/u, ""));
}

export function matchHotKey(
  source: string,
  event: HotKeyEvent,
  options: HotKeyMatchOptions = {},
): boolean {
  const parsed = parseHotKey(source);
  if (!parsed || eventKey(event) !== parsed.key) return false;
  const platform = detectNoemaPlatform(options.platform || "");
  const expectedMeta = parsed.meta || (parsed.primary && isMacPlatform(platform));
  const expectedCtrl = parsed.ctrl || (parsed.primary && !isMacPlatform(platform));
  if (expectedMeta && !event.metaKey) return false;
  if (expectedCtrl && !event.ctrlKey) return false;
  if (parsed.alt && !event.altKey) return false;
  if (parsed.shift && !event.shiftKey) return false;
  if (!options.allowExtraModifiers) {
    if (!expectedMeta && event.metaKey) return false;
    if (!expectedCtrl && event.ctrlKey) return false;
    if (!parsed.alt && event.altKey) return false;
    if (!parsed.shift && event.shiftKey) return false;
  }
  return true;
}

function keyLabel(key: string): string {
  const labels: Record<string, string> = {
    escape: "Esc",
    enter: "Enter",
    " ": "Space",
    arrowup: "↑",
    arrowdown: "↓",
    arrowleft: "←",
    arrowright: "→",
  };
  return labels[key] ?? (key.length === 1 ? key.toUpperCase() : key);
}

export function formatHotKey(
  source: string,
  platform: NoemaPlatform | string = detectNoemaPlatform(),
): string {
  const parsed = parseHotKey(source);
  if (!parsed) return source;
  const mac = isMacPlatform(platform);
  const modifiers: string[] = [];
  const meta = parsed.meta || (parsed.primary && mac);
  const ctrl = parsed.ctrl || (parsed.primary && !mac);
  if (ctrl) modifiers.push(mac ? "⌃" : "Ctrl");
  if (parsed.alt) modifiers.push(mac ? "⌥" : "Alt");
  if (parsed.shift) modifiers.push(mac ? "⇧" : "Shift");
  if (meta) modifiers.push(mac ? "⌘" : "Meta");
  const key = keyLabel(parsed.key);
  return mac ? `${modifiers.join("")}${key}` : [...modifiers, key].join("+");
}
