/**
 * The math macro set the page renders with, layer by layer:
 *
 *   shared   resources/katex-macros/*.tex           (files, not managed here)
 *   user     ~/.config/noema/katex-macros.tex        (managed in the palette)
 *   project  the note's `macros-from` .cls/.sty/.tex (read by the host)
 *   local    the note's `#+begin macros` block       (managed in the palette)
 *
 * Later layers win. A note's layers are installed before the note is painted,
 * so opening a note never renders its math twice. Editing the meta block
 * re-derives them once typing pauses, and only a real change of the merged
 * set re-renders the preview. Only the head of the document is scanned.
 */

import type { ChangeSet, Text } from "@codemirror/state";
import { noteMacroSpec, noteMacroBlockEdit } from "../shared/note-macros.mjs";
import { parseLatexMacros } from "../shared/katex-macros.mjs";
import type { KatexMacrosResult, NoteKatexMacrosResult } from "./api-client.ts";

type MacroMap = Record<string, string>;

export interface NoteMacroLayers {
  shared: MacroMap;
  user: MacroMap;
  project: MacroMap;
  local: MacroMap;
  files: string[];
  from: string[];
  errors: { file: string; message: string }[];
  file: string;
  userFile: string;
}

export interface NoteMacroRuntimeDeps {
  loadGlobal: () => Promise<KatexMacrosResult>;
  saveUser: (macros: MacroMap) => Promise<KatexMacrosResult>;
  loadNote: (file: string, paths: string[]) => Promise<NoteKatexMacrosResult>;
  install: (macros: MacroMap) => void;
  rerender: () => void;
  composing?: () => boolean;
}

const EDIT_SETTLE_MS = 500;
/** `noteMacroSpec` stops at the meta block; never hand it more than this. */
const HEAD_LINE_LIMIT = 820;
const PREAMBLE_LINES = 12;

function hashMacros(map: MacroMap): string {
  const keys = Object.keys(map).sort();
  let h = 0x811c9dc5;
  for (const key of keys) {
    const entry = `${key}=${map[key]}\u0000`;
    for (let i = 0; i < entry.length; i++) { h ^= entry.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  }
  return `${(h >>> 0).toString(36)}.${keys.length}`;
}

export function documentHead(doc: Text): string {
  return doc.sliceString(0, doc.line(Math.min(doc.lines, HEAD_LINE_LIMIT)).to);
}

export function createNoteMacroRuntime(deps: NoteMacroRuntimeDeps) {
  let shared: MacroMap = {};
  let user: MacroMap = {};
  let userFile = "";
  let file = "";
  let from: string[] = [];
  let project: MacroMap = {};
  let projectKey = "";
  let projectFiles: string[] = [];
  let local: MacroMap = {};
  let localText = "";
  let errors: { file: string; message: string }[] = [];
  let watchTo = 0;
  let installed = "";
  let editTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingDoc: Text | null = null;
  let epoch = 0;
  const listeners = new Set<() => void>();

  const notify = (): void => { for (const listener of listeners) listener(); };

  function apply(rerender: boolean): void {
    const merged = { ...shared, ...user, ...project, ...local };
    const hash = hashMacros(merged);
    if (hash !== installed) {
      installed = hash;
      deps.install(merged);
      if (rerender) deps.rerender();
    }
    notify();
  }

  function adoptGlobal(result: KatexMacrosResult): void {
    shared = result.shared ?? result.macros ?? {};
    user = result.user?.macros ?? {};
    userFile = result.user?.file ?? "";
  }

  function readHead(head: string, doc: Text | null): { key: string } {
    const spec = noteMacroSpec(head);
    from = spec?.from ?? [];
    localText = spec?.text ?? "";
    const parsed = localText.trim() ? parseLatexMacros([{ name: "#+begin macros", text: localText }]) : { macros: {}, errors: [] };
    local = parsed.macros;
    errors = parsed.errors;
    if (spec) watchTo = spec.metaTo;
    else if (doc) watchTo = doc.line(Math.min(doc.lines, PREAMBLE_LINES)).to;
    else {
      let at = 0;
      for (let line = 0; line < PREAMBLE_LINES && at >= 0; line++) at = head.indexOf("\n", at + 1);
      watchTo = at < 0 ? head.length : at;
    }
    return { key: `${file}\u0000${from.join("\u0000")}` };
  }

  async function refreshProject(key: string, force = false): Promise<void> {
    if (!from.length) {
      // A previous note may still have a project-file request in flight.
      epoch++;
      project = {};
      projectFiles = [];
      projectKey = key;
      return;
    }
    if (key === projectKey && !force) return;
    const ticket = ++epoch;
    const previousProject = projectKey === key ? project : {};
    const previousFiles = projectKey === key ? projectFiles : [];
    const result = await deps.loadNote(file, from).catch((error: unknown) => ({
      // A failed refresh is not a new macro set. Keep the last usable one for
      // this note until a later refresh succeeds.
      project: previousProject,
      files: previousFiles,
      errors: [{ file: from.join(", "), message: error instanceof Error ? error.message : String(error) }],
    }) as NoteKatexMacrosResult);
    if (ticket !== epoch) return;
    // The host can resolve some files and report errors for others. That is
    // still an incomplete refresh: keep the last complete dictionary for the
    // same note until all referenced files load successfully.
    const keepPrevious = projectKey === key && Boolean(result.errors?.length);
    project = keepPrevious ? previousProject : result.project ?? {};
    projectFiles = keepPrevious ? previousFiles : result.files ?? [];
    projectKey = key;
    errors = [...errors, ...(result.errors ?? [])];
  }

  function cancelEdit(): void {
    if (editTimer) clearTimeout(editTimer);
    editTimer = null;
    pendingDoc = null;
  }

  return {
    async loadGlobal(rerender = false): Promise<void> {
      try {
        adoptGlobal(await deps.loadGlobal());
      } catch {
        // Macros are optional; the page renders without them.
      }
      apply(rerender);
    },

    /**
     * Install a note's layers before it is painted. FORCE re-reads its
     * project files, which may have changed on disk (a refresh).
     */
    async prepare(nextFile: string, content: string, force = false): Promise<void> {
      cancelEdit();
      file = nextFile;
      const { key } = readHead(content, null);
      await refreshProject(key, force);
      apply(false);
    },

    /**
     * A note was installed without `prepare` (a path that already had the
     * text). Its local layer is applied at once; project files follow.
     */
    adopt(nextFile: string, content: string): void {
      cancelEdit();
      file = nextFile;
      const { key } = readHead(content, null);
      if (key === projectKey || !from.length) {
        if (!from.length) { epoch++; project = {}; projectFiles = []; projectKey = key; }
        apply(false);
        return;
      }
      // Its project files are not loaded yet: render with what is known and
      // re-render once they arrive.
      project = {};
      projectFiles = [];
      apply(false);
      void refreshProject(key).then(() => apply(true));
    },

    /** Called for every document change; cheap unless the meta block moved. */
    noteEdited(changes: ChangeSet, doc: Text): void {
      if (!changes.touchesRange(0, watchTo)) {
        watchTo = changes.mapPos(watchTo, 1);
        return;
      }
      watchTo = changes.mapPos(watchTo, 1);
      pendingDoc = doc;
      if (editTimer) clearTimeout(editTimer);
      editTimer = setTimeout(function settle() {
        editTimer = null;
        if (deps.composing?.()) { editTimer = setTimeout(settle, EDIT_SETTLE_MS); return; }
        const current = pendingDoc;
        pendingDoc = null;
        if (!current) return;
        const { key } = readHead(documentHead(current), current);
        void refreshProject(key).then(() => apply(true));
      }, EDIT_SETTLE_MS);
    },

    /** Re-read the project files (they may have changed on disk). */
    async reloadProject(): Promise<void> {
      await refreshProject(`${file}\u0000${from.join("\u0000")}`, true);
      apply(true);
    },

    async saveUser(next: MacroMap): Promise<void> {
      adoptGlobal(await deps.saveUser(next));
      apply(true);
    },

    /** The edit that writes NEXT as the note's local block, or null. */
    localBlockEdit(markdown: string, next: MacroMap): { from: number; to: number; insert: string } | null {
      return noteMacroBlockEdit(markdown, next);
    },

    layers(): NoteMacroLayers {
      return { shared, user, project, local, files: projectFiles, from, errors, file, userFile };
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    dispose(): void {
      cancelEdit();
      listeners.clear();
      epoch++;
    },
  };
}

export type NoteMacroRuntime = ReturnType<typeof createNoteMacroRuntime>;
