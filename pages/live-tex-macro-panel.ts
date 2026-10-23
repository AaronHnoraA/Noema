/**
 * The formula palette's macro tab.
 *
 * Four layers are shown, later ones winning: shared (resources, read-only),
 * project (`macros-from`, read-only), global (the user's file) and this note
 * (`#+begin macros`). The two editable layers share one form. Each row also
 * inserts its macro, with a placeholder per argument, so the tab doubles as
 * the palette's "my formulas" page.
 *
 * Row previews are typeset only when a row scrolls into view; the observer
 * belongs to one render and is released by its disposer.
 */

import katex from "katex";
import { balancedMacroBody, macroArity, validMacroName } from "../shared/note-macros.mjs";
import type { NoteMacroLayers } from "./note-macros-runtime.ts";
import type { LiveTexPaletteItem } from "./live-tex-palette.ts";

export const LIVE_TEX_MACRO_CATEGORY = "macros";

export type MacroScope = "local" | "user" | "project" | "shared";

export interface MacroPanelState {
  scope: MacroScope;
  /** The name being edited, or null for a new macro. */
  editing: string | null;
  message: string;
}

const SCOPES: { id: MacroScope; label: string; title: string }[] = [
  { id: "local", label: "本笔记", title: "Macros in this note's #+begin macros block" },
  { id: "user", label: "全局", title: "Your global macros (~/.config/noema/katex-macros.tex)" },
  { id: "project", label: "项目", title: "Imported from the files named by macros-from" },
  { id: "shared", label: "共享", title: "Shared macro files (resources/katex-macros), read-only here" },
];

export function macroInsertTemplate(name: string, body: string): string {
  return name + "{\\placeholder{}}".repeat(macroArity(body));
}

function layerOf(layers: NoteMacroLayers, scope: MacroScope): Record<string, string> {
  return scope === "local" ? layers.local : scope === "user" ? layers.user : scope === "project" ? layers.project : layers.shared;
}

/** Every macro in effect, as palette items, for search. */
export function macroPaletteItems(layers: NoteMacroLayers): LiveTexPaletteItem[] {
  const merged = new Map<string, { body: string; scope: MacroScope }>();
  for (const scope of ["shared", "project", "user", "local"] as const) {
    for (const [name, body] of Object.entries(layerOf(layers, scope))) merged.set(name, { body, scope });
  }
  return [...merged].map(([name, { body, scope }]) => ({
    label: name,
    name: `宏 · ${SCOPES.find((entry) => entry.id === scope)!.label}`,
    latex: macroInsertTemplate(name, body),
    keywords: body,
  }));
}

export function validateMacroDraft(name: string, body: string): string {
  if (!validMacroName(name)) return "名称须为 \\ 加字母，例如 \\Mon";
  if (!body.trim()) return "定义不能为空";
  if (/[\r\n]/.test(body)) return "定义须为一行";
  if (!balancedMacroBody(body)) return "花括号不配对";
  if (body.length > 2000) return "定义过长";
  return "";
}

/** Typeset a draft with the draft itself defined; never touches the shared cache. */
export function previewMacroDraft(name: string, body: string, macros: Record<string, string>): string {
  if (!validMacroName(name) || !balancedMacroBody(body)) return "";
  try {
    return katex.renderToString(macroInsertTemplate(name, body).replace(/\\placeholder\{\}/g, "\\square"), {
      macros: { ...macros, [name]: body },
      throwOnError: true,
      displayMode: false,
      strict: "ignore",
    });
  } catch (error) {
    return `<span class="noema-livetex-macro-error">${String(error instanceof Error ? error.message : error).replace(/[<&]/g, (c) => (c === "<" ? "&lt;" : "&amp;"))}</span>`;
  }
}

export interface MacroPanelRender {
  fragment: DocumentFragment;
  items: LiveTexPaletteItem[];
  dispose: () => void;
}

export function buildMacroPanel(
  layers: NoteMacroLayers,
  state: MacroPanelState,
  options: { readOnly: boolean; renderPreview: (tex: string) => string; draftMacros: () => Record<string, string> },
): MacroPanelRender {
  const fragment = document.createDocumentFragment();
  const items: LiveTexPaletteItem[] = [];
  const editable = !options.readOnly && (state.scope === "local" || state.scope === "user");

  const scopes = document.createElement("div");
  scopes.className = "noema-livetex-macro-scopes";
  scopes.setAttribute("role", "tablist");
  for (const scope of SCOPES) {
    const count = Object.keys(layerOf(layers, scope.id)).length;
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.livetexMacroScope = scope.id;
    button.title = scope.title;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(scope.id === state.scope));
    button.append(scope.label, Object.assign(document.createElement("small"), { textContent: String(count) }));
    scopes.append(button);
  }
  fragment.append(scopes);

  if (editable) {
    const layer = layerOf(layers, state.scope);
    const form = document.createElement("form");
    form.className = "noema-livetex-macro-form";
    form.dataset.livetexMacroForm = "";
    const name = Object.assign(document.createElement("input"), {
      name: "name", placeholder: "\\name", spellcheck: false, autocomplete: "off", value: state.editing ?? "",
    });
    name.setAttribute("aria-label", "宏名称");
    const body = Object.assign(document.createElement("input"), {
      name: "body", placeholder: "定义，参数写 #1 #2 …", spellcheck: false, autocomplete: "off",
      value: state.editing ? layer[state.editing] ?? "" : "",
    });
    body.setAttribute("aria-label", "宏定义");
    const preview = document.createElement("output");
    preview.className = "noema-livetex-macro-draft";
    const refresh = (): void => {
      preview.innerHTML = previewMacroDraft(name.value.trim(), body.value, options.draftMacros());
    };
    name.addEventListener("input", refresh);
    body.addEventListener("input", refresh);
    refresh();
    const save = Object.assign(document.createElement("button"), { type: "submit", textContent: state.editing ? "更新" : "添加" });
    form.append(name, body, preview, save);
    if (state.editing) {
      const cancel = Object.assign(document.createElement("button"), { type: "button", textContent: "取消" });
      cancel.dataset.livetexMacroAction = "cancel";
      form.append(cancel);
    }
    fragment.append(form);
  } else if (state.scope === "project") {
    const note = document.createElement("p");
    note.className = "noema-livetex-macro-note";
    note.textContent = layers.from.length
      ? `macros-from: ${layers.from.join(", ")}`
      : "在 meta 中写 macros-from: path/to/file.cls 导入项目宏";
    fragment.append(note);
  }

  if (state.message) {
    const message = document.createElement("p");
    message.className = "noema-livetex-macro-message";
    message.textContent = state.message;
    fragment.append(message);
  }

  const list = document.createElement("div");
  list.className = "noema-livetex-macro-list";
  const layer = layerOf(layers, state.scope);
  const lower: Record<string, string> = state.scope === "local" ? { ...layers.shared, ...layers.project, ...layers.user }
    : state.scope === "user" ? { ...layers.shared, ...layers.project }
      : state.scope === "project" ? layers.shared : {};
  const pending: HTMLElement[] = [];
  for (const [macro, definition] of Object.entries(layer).sort(([a], [b]) => a.localeCompare(b))) {
    const index = items.length;
    const template = macroInsertTemplate(macro, definition);
    items.push({ label: macro, name: macro, latex: template, keywords: definition });
    const row = document.createElement("div");
    row.className = "noema-livetex-macro-row";
    const insert = document.createElement("button");
    insert.type = "button";
    insert.className = "noema-livetex-macro-insert";
    insert.dataset.livetexPaletteIndex = String(index);
    insert.title = `插入 ${template}`;
    const code = Object.assign(document.createElement("code"), { textContent: macro });
    const glyph = document.createElement("span");
    glyph.className = "noema-livetex-macro-glyph";
    glyph.dataset.tex = template.replace(/\\placeholder\{\}/g, "\\square");
    pending.push(glyph);
    const source = Object.assign(document.createElement("span"), { className: "noema-livetex-macro-body", textContent: definition });
    insert.append(code, glyph, source);
    if (macro in lower && lower[macro] !== definition) {
      insert.append(Object.assign(document.createElement("em"), { textContent: "覆盖", title: `Overrides: ${lower[macro]}` }));
    }
    row.append(insert);
    if (editable) {
      for (const [action, label, title] of [["edit", "编辑", "Edit"], ["delete", "×", "Delete"]] as const) {
        const button = Object.assign(document.createElement("button"), { type: "button", textContent: label, title });
        button.dataset.livetexMacroAction = action;
        button.dataset.livetexMacroName = macro;
        row.append(button);
      }
    }
    list.append(row);
  }
  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "noema-livetex-palette-empty";
    empty.textContent = state.scope === "local" ? "本笔记还没有宏；在上方添加，会写入 meta 的 #+begin macros"
      : state.scope === "user" ? "还没有全局宏；在上方添加"
        : state.scope === "project" ? "没有导入的项目宏" : "没有共享宏";
    list.append(empty);
  }
  fragment.append(list);
  if (layers.errors.length) {
    const errors = document.createElement("p");
    errors.className = "noema-livetex-macro-message";
    errors.textContent = layers.errors.slice(0, 3).map((error) => `${error.file}: ${error.message}`).join(" · ");
    fragment.append(errors);
  }

  let observer: IntersectionObserver | null = null;
  const typeset = (glyph: HTMLElement): void => {
    if (!glyph.dataset.tex) return;
    glyph.innerHTML = options.renderPreview(glyph.dataset.tex);
    delete glyph.dataset.tex;
  };
  if (typeof IntersectionObserver === "function") {
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        typeset(entry.target as HTMLElement);
        observer?.unobserve(entry.target);
      }
    }, { root: null, rootMargin: "120px 0px" });
    for (const glyph of pending) observer.observe(glyph);
  } else {
    for (const glyph of pending) typeset(glyph);
  }
  return { fragment, items, dispose: () => { observer?.disconnect(); observer = null; } };
}
