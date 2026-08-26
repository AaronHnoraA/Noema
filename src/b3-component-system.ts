import "./styles/b3-components.css";

export type B3SurfaceKind = "dialog" | "dialog-host" | "menu" | "panel";

export type B3ComponentAudit = {
  surfaces: number;
  dialogs: number;
  dialogHosts: number;
  menus: number;
  panels: number;
  controls: number;
  candidates: number;
  unadopted: string[];
};

const DIALOG_CONTAINER_TOKENS = new Set([
  "aaronnote-modal-panel",
]);

const PANEL_TOKENS = new Set([
  "aaronnote-tools-panel",
  "aaronnote-jupyter-panel",
  "aaronnote-floating-toc",
  "aaronnote-local-graph-panel",
  "aaronnote-find-panel",
  "noema-knowledge-dock",
  "aaronnote-agenda-full",
  "aaronnote-roam-tools",
  "noema-config-section",
  "noema-jupyter-inspector",
  "noema-jupyter-manager",
  "noema-jupyter-tasks",
  "aaronnote-link-preview",
  "aaronnote-math-preview",
  "noema-wiki-sidebar",
  "noema-wiki-tools",
]);

const CARD_TOKENS = new Set([
  "aaronnote-task-card",
  "noema-config-plugin",
  "noema-config-theme",
  "noema-jupyter-manager-card",
]);

const CONTROL_SELECTOR = "button, input, select, textarea, [role='option'], [role='tab'], hr";
const CANDIDATE_SELECTOR = "dialog, aside, [role='dialog'], [role='menu'], [role='listbox'], [class]";

function classTokens(element: Element): string[] {
  return [...element.classList];
}

function tokenEndsWithSurface(token: string, suffix: string): boolean {
  return token.endsWith(`-${suffix}`) || token.endsWith(`__${suffix}`);
}

function isDialogHost(tokens: string[]): boolean {
  if (tokens.includes("aaronnote-modal")) return true;
  return tokens.some((token) => tokenEndsWithSurface(token, "backdrop"));
}

export function b3SurfaceKind(element: Element): B3SurfaceKind | null {
  if (!(element instanceof HTMLElement)) return null;
  const tokens = classTokens(element);
  if (element.matches("dialog, [role='dialog']") || tokens.some((token) => DIALOG_CONTAINER_TOKENS.has(token))) {
    return "dialog";
  }
  if (isDialogHost(tokens)) return "dialog-host";
  if (element.matches("[role='menu'], [role='listbox']")
      || (element.tagName !== "BUTTON" && element.tagName !== "SUMMARY"
        && tokens.some((token) => tokenEndsWithSurface(token, "menu") || tokenEndsWithSurface(token, "popup")))) {
    return "menu";
  }
  // Panels are deliberately opt-in. Structural <aside> elements and document
  // regions whose historical class happens to end in "-panel" (the status
  // HUD and bibliography are the important examples) belong to the shared
  // editor canvas; decorating them as b3 panels creates a second background,
  // border, and shadow in both Electron and Emacs.
  if (tokens.some((token) => PANEL_TOKENS.has(token))) {
    return "panel";
  }
  return null;
}

function buttonIntent(button: HTMLButtonElement): "primary" | "cancel" | "remove" | "text" {
  const value = [
    button.textContent,
    button.getAttribute("aria-label"),
    button.getAttribute("title"),
    ...Object.keys(button.dataset),
    ...Object.values(button.dataset),
  ].join(" ").toLocaleLowerCase();
  if (button.dataset.danger === "true" || /\b(delete|remove|trash|discard)\b/.test(value)) return "remove";
  if (/\b(close|cancel|dismiss|back|forward|previous|next|refresh)\b/.test(value)) return "cancel";
  if (button.type === "submit" || /\b(ok|apply|save|open|create|add|run|export|switch|retry|rerun)\b/.test(value)) return "primary";
  return "text";
}

function decorateButton(button: HTMLButtonElement, surface: HTMLElement): void {
  const kind = surface.dataset.noemaB3Surface as B3SurfaceKind | undefined;
  if (kind === "menu" || button.getAttribute("role") === "option") {
    button.classList.remove("b3-button", "b3-button--cancel", "b3-button--remove", "b3-button--text", "b3-list-item");
    button.classList.add("b3-menu__item");
    return;
  }
  if (button.getAttribute("role") === "tab") {
    button.classList.remove("b3-button", "b3-button--cancel", "b3-button--remove", "b3-button--text", "b3-menu__item");
    button.classList.add("b3-list-item");
    return;
  }
  button.classList.remove("b3-menu__item", "b3-list-item", "b3-button--cancel", "b3-button--remove", "b3-button--text");
  button.classList.add("b3-button");
  const intent = buttonIntent(button);
  if (intent !== "primary") button.classList.add(`b3-button--${intent}`);
}

function decorateControl(element: Element): void {
  if (!(element instanceof HTMLElement)) return;
  const surface = element.closest<HTMLElement>("[data-noema-b3-surface]");
  if (!surface) return;
  if (element instanceof HTMLButtonElement) {
    decorateButton(element, surface);
  } else if (element instanceof HTMLSelectElement) {
    element.classList.add("b3-select");
  } else if (element instanceof HTMLTextAreaElement) {
    element.classList.add("b3-text-field");
  } else if (element instanceof HTMLInputElement) {
    if (element.type === "range") element.classList.add("b3-slider");
    else if (element.type === "checkbox") element.classList.add("b3-switch");
    else if (!["hidden", "radio", "file"].includes(element.type)) element.classList.add("b3-text-field");
  } else if (element.getAttribute("role") === "option" || element.getAttribute("role") === "tab") {
    element.classList.add("b3-list-item");
  } else if (element instanceof HTMLHRElement) {
    element.classList.add("b3-menu__separator");
  }
}

function decorateDialogStructure(container: HTMLElement): void {
  const header = container.querySelector<HTMLElement>(":scope > header, :scope > form > header, :scope > h2");
  header?.classList.add("b3-dialog__header");
  for (const action of container.querySelectorAll<HTMLElement>(
    ":scope > footer, :scope > form > footer, :scope > [class$='-actions'], :scope > [class*='-actions ']",
  )) action.classList.add("b3-dialog__action");
}

function decoratePanelStructure(panel: HTMLElement): void {
  panel.querySelector<HTMLElement>(":scope > header, :scope > [class$='-head'], :scope > [class*='-head ']")
    ?.classList.add("b3-panel__header");
  for (const list of panel.querySelectorAll<HTMLElement>("[role='tablist'], [role='listbox']")) {
    list.classList.add("b3-list", "b3-list--background");
  }
}

function decorateCards(root: ParentNode): void {
  const candidates: Element[] = root instanceof Element ? [root, ...root.querySelectorAll("[class]")] : [...root.querySelectorAll("[class]")];
  for (const candidate of candidates) {
    if (!(candidate instanceof HTMLElement)) continue;
    if (classTokens(candidate).some((token) => CARD_TOKENS.has(token))) candidate.classList.add("b3-card");
  }
}

function decorateSurface(surface: HTMLElement, kind: B3SurfaceKind): void {
  surface.dataset.noemaB3Surface = kind;
  if (kind === "dialog-host") surface.classList.add("b3-dialog", "b3-dialog--open");
  else if (kind === "dialog") {
    surface.classList.add("b3-dialog__container");
    decorateDialogStructure(surface);
  } else if (kind === "menu") surface.classList.add("b3-menu");
  else {
    surface.classList.add("b3-panel");
    decoratePanelStructure(surface);
  }
  for (const control of surface.querySelectorAll(CONTROL_SELECTOR)) decorateControl(control);
  decorateCards(surface);
}

function candidateElements(root: ParentNode): Element[] {
  const elements = [...root.querySelectorAll(CANDIDATE_SELECTOR)];
  if (root instanceof Element && root.matches(CANDIDATE_SELECTOR)) elements.unshift(root);
  return elements;
}

/** Apply the b3 contract synchronously to an existing subtree. */
export function applyB3ComponentSystem(root: ParentNode): void {
  for (const element of candidateElements(root)) {
    const kind = b3SurfaceKind(element);
    if (kind) decorateSurface(element as HTMLElement, kind);
  }
  const containingSurface = root instanceof Element
    ? root.closest<HTMLElement>("[data-noema-b3-surface]")
    : null;
  if (containingSurface) {
    if (root instanceof Element && root.matches(CONTROL_SELECTOR)) decorateControl(root);
    for (const control of root.querySelectorAll(CONTROL_SELECTOR)) decorateControl(control);
    decorateCards(root);
  }
}

/**
 * Install the source-owned b3 adapter.  Mutation work is bounded to newly
 * added semantic surfaces or descendants of an already-adopted surface; CM6
 * document churn outside those roots is ignored.
 */
export function installB3ComponentSystem(root: HTMLElement): () => void {
  applyB3ComponentSystem(root);
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        const parentSurface = node.parentElement?.closest<HTMLElement>("[data-noema-b3-surface]");
        const containsCandidate = node.matches(CANDIDATE_SELECTOR) || Boolean(node.querySelector(CANDIDATE_SELECTOR));
        if (parentSurface || containsCandidate) applyB3ComponentSystem(node);
      }
    }
  });
  observer.observe(root, { childList: true, subtree: true });
  return () => observer.disconnect();
}

function surfaceIdentity(element: HTMLElement): string {
  if (element.id) return `#${element.id}`;
  const stableClass = classTokens(element).find((token) => !token.startsWith("b3-") && !token.startsWith("is-"));
  return stableClass ? `.${stableClass}` : element.tagName.toLocaleLowerCase();
}

/** Runtime evidence used by tests and the packaged smoke report. */
export function auditB3ComponentSystem(root: ParentNode): B3ComponentAudit {
  const candidates = candidateElements(root)
    .map((element) => ({ element: element as HTMLElement, kind: b3SurfaceKind(element) }))
    .filter((entry): entry is { element: HTMLElement; kind: B3SurfaceKind } => Boolean(entry.kind));
  const unadopted: string[] = [];
  for (const { element, kind } of candidates) {
    const expected = kind === "dialog-host" ? "b3-dialog"
      : kind === "dialog" ? "b3-dialog__container"
        : kind === "menu" ? "b3-menu" : "b3-panel";
    if (element.dataset.noemaB3Surface !== kind || !element.classList.contains(expected)) {
      unadopted.push(`${kind}:${surfaceIdentity(element)}`);
    }
  }
  const surfaces = [...root.querySelectorAll<HTMLElement>("[data-noema-b3-surface]")];
  const controls = root.querySelectorAll(
    ".b3-button, .b3-menu__item, .b3-list-item, .b3-text-field, .b3-select, .b3-slider, .b3-switch",
  ).length;
  return {
    surfaces: surfaces.length,
    dialogs: surfaces.filter((surface) => surface.dataset.noemaB3Surface === "dialog").length,
    dialogHosts: surfaces.filter((surface) => surface.dataset.noemaB3Surface === "dialog-host").length,
    menus: surfaces.filter((surface) => surface.dataset.noemaB3Surface === "menu").length,
    panels: surfaces.filter((surface) => surface.dataset.noemaB3Surface === "panel").length,
    controls,
    candidates: candidates.length,
    unadopted,
  };
}
