import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "@voidzero-dev/vite-plus-test";

import {
  applyB3ComponentSystem,
  auditB3ComponentSystem,
  b3SurfaceKind,
  installB3ComponentSystem,
} from "../src/b3-component-system.ts";

function read(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

afterEach(() => {
  document.body.replaceChildren();
  document.body.className = "";
});

describe("b3 component system", () => {
  test("classifies Noema semantic surfaces without treating ordinary editor DOM as chrome", () => {
    const dialog = document.createElement("dialog");
    const host = document.createElement("div");
    host.className = "aaronnote-task-manager-backdrop";
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    const dock = document.createElement("aside");
    dock.className = "noema-knowledge-dock";
    const editorBlock = document.createElement("div");
    editorBlock.className = "cm-line";
    const dropOverlay = document.createElement("div");
    dropOverlay.className = "noema-desktop-drop-overlay";
    const themePreview = document.createElement("span");
    themePreview.className = "noema-config-theme-preview";

    expect(b3SurfaceKind(dialog)).toBe("dialog");
    expect(b3SurfaceKind(host)).toBe("dialog-host");
    expect(b3SurfaceKind(menu)).toBe("menu");
    expect(b3SurfaceKind(dock)).toBe("panel");
    expect(b3SurfaceKind(editorBlock)).toBeNull();
    expect(b3SurfaceKind(dropOverlay)).toBeNull();
    expect(b3SurfaceKind(themePreview)).toBeNull();
  });

  test("adopts dialog, menu, panel, form and card controls through the b3 contract", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <div class="aaronnote-modal">
        <form class="aaronnote-modal-panel">
          <h2>Settings</h2>
          <input type="text">
          <select><option>One</option></select>
          <input type="range">
          <input type="checkbox">
          <div class="aaronnote-modal-actions">
            <button type="button">Cancel</button>
            <button type="submit">Save</button>
            <button type="button" data-danger="true">Delete</button>
          </div>
          <div role="listbox"><button type="button" role="option">Choice</button></div>
        </form>
      </div>
      <aside class="noema-knowledge-dock">
        <header>Knowledge</header>
        <nav role="tablist"><button type="button" role="tab">Backlinks</button></nav>
      </aside>
      <div class="aaronnote-context-menu" role="menu">
        <button type="button">Open</button><hr><button type="button">Close</button>
      </div>
      <section class="noema-config-section"><button class="noema-config-theme">Theme</button></section>
    `;
    document.body.appendChild(root);
    applyB3ComponentSystem(root);

    expect(root.querySelector(".aaronnote-modal")?.classList.contains("b3-dialog")).toBe(true);
    expect(root.querySelector(".aaronnote-modal-panel")?.classList.contains("b3-dialog__container")).toBe(true);
    expect(root.querySelector("h2")?.classList.contains("b3-dialog__header")).toBe(true);
    expect(root.querySelector(".aaronnote-modal-actions")?.classList.contains("b3-dialog__action")).toBe(true);
    expect(root.querySelector("input[type='text']")?.classList.contains("b3-text-field")).toBe(true);
    expect(root.querySelector("select")?.classList.contains("b3-select")).toBe(true);
    expect(root.querySelector("input[type='range']")?.classList.contains("b3-slider")).toBe(true);
    expect(root.querySelector("input[type='checkbox']")?.classList.contains("b3-switch")).toBe(true);

    const modalButtons = [...root.querySelectorAll<HTMLButtonElement>(".aaronnote-modal-actions button")];
    expect(modalButtons[0]?.classList.contains("b3-button--cancel")).toBe(true);
    expect(modalButtons[1]?.classList.contains("b3-button")).toBe(true);
    expect(modalButtons[1]?.classList.contains("b3-button--text")).toBe(false);
    expect(modalButtons[2]?.classList.contains("b3-button--remove")).toBe(true);

    const option = root.querySelector<HTMLButtonElement>("[role='option']")!;
    expect(option.classList.contains("b3-menu__item")).toBe(true);
    expect(option.classList.contains("b3-button")).toBe(false);
    expect(root.querySelector(".noema-knowledge-dock")?.classList.contains("b3-panel")).toBe(true);
    expect(root.querySelector("[role='tablist']")?.classList.contains("b3-list--background")).toBe(true);
    expect(root.querySelector("[role='tab']")?.classList.contains("b3-list-item")).toBe(true);
    expect(root.querySelector(".aaronnote-context-menu")?.classList.contains("b3-menu")).toBe(true);
    expect(root.querySelector("hr")?.classList.contains("b3-menu__separator")).toBe(true);
    expect(root.querySelector(".noema-config-section")?.classList.contains("b3-panel")).toBe(true);
    expect(root.querySelector(".noema-config-theme")?.classList.contains("b3-card")).toBe(true);

    const audit = auditB3ComponentSystem(root);
    expect(audit.unadopted).toEqual([]);
    expect(audit.candidates).toBe(audit.surfaces);
    expect(audit).toEqual(expect.objectContaining({ dialogHosts: 1, dialogs: 1, menus: 2, panels: 2 }));
    expect(audit.controls).toBeGreaterThanOrEqual(10);
  });

  test("adopts dynamically rendered controls only inside semantic surfaces", async () => {
    const stop = installB3ComponentSystem(document.body);
    try {
      const ordinary = document.createElement("div");
      ordinary.className = "cm-editor";
      ordinary.innerHTML = "<button>Editor-owned button</button>";
      document.body.appendChild(ordinary);

      const panel = document.createElement("aside");
      panel.className = "aaronnote-jupyter-panel";
      document.body.appendChild(panel);
      const dynamic = document.createElement("button");
      dynamic.textContent = "Refresh";
      panel.appendChild(dynamic);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(ordinary.querySelector("button")?.classList.contains("b3-button")).toBe(false);
      expect(panel.classList.contains("b3-panel")).toBe(true);
      expect(dynamic.classList.contains("b3-button--cancel")).toBe(true);
      expect(auditB3ComponentSystem(document.body).unadopted).toEqual([]);
    } finally {
      stop();
    }
  });

  test("ships the adapter on every interactive application route and reports it in packaged smoke", () => {
    for (const entry of [
      "aaronnote/main.ts",
      "aaronnote/wiki-main.ts",
      "aaronnote/jupyter-main.ts",
      "aaronnote/config-main.ts",
      "aaronnote/agenda-main.ts",
    ]) {
      const source = read(entry);
      expect(source).toContain("installB3ComponentSystem");
      expect(source).toContain("removeB3ComponentSystem");
    }
    const bridge = read("aaronnote/desktop-bridge.ts");
    expect(bridge).toContain("auditB3ComponentSystem(document.body)");
    expect(bridge).toContain("b3Components");
    expect(bridge).toContain('knowledgeDock: Boolean(knowledgeDock?.classList.contains("b3-panel"))');
    expect(bridge).toContain('tocPopover: Boolean(tocPopover?.classList.contains("b3-panel"))');
    expect(bridge).toContain('agendaDock: Boolean(agendaDock?.classList.contains("b3-panel"))');
  });

  test("keeps the b3 layer palette-owned while host adapters retain geometry", () => {
    const css = read("src/styles/b3-components.css");
    for (const component of [
      ".b3-dialog__container",
      ".b3-menu__item",
      ".b3-panel",
      ".b3-button--text",
      ".b3-text-field",
      ".b3-select",
      ".b3-slider",
      ".b3-switch",
      ".b3-card",
    ]) expect(css).toContain(component);
    for (const variable of [
      "--b3-theme-primary",
      "--b3-theme-surface",
      "--b3-theme-on-background",
      "--b3-menu-background",
      "--b3-border-color",
      "--b3-list-hover",
      "--b3-dialog-shadow",
    ]) expect(css).toContain(`var(${variable})`);
    const usedVariables = new Set([...css.matchAll(/var\((--b3-[a-z0-9-]+)/g)].map((match) => match[1]));
    expect(usedVariables.size).toBeGreaterThanOrEqual(25);
    for (const theme of ["daylight", "midnight"]) {
      const themeCss = read(`app/appearance/themes/${theme}/theme.css`);
      const defined = new Set([...themeCss.matchAll(/(--b3-[a-z0-9-]+)\s*:/g)].map((match) => match[1]));
      expect([...usedVariables].filter((variable) => !defined.has(variable))).toEqual([]);
    }
    expect(css).not.toMatch(/\.b3-dialog__container[^}]*\b(?:width|max-width|height|max-height|position)\s*:/s);
    expect(css).not.toMatch(/\.b3-panel[^}]*\b(?:width|height|position)\s*:/s);
  });
});
