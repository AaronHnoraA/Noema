import { StateEffect, StateField, type Transaction } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";

export type ProseDiagnosticSource = "languagetool" | "browser";

/** The classes LanguageTool's clients colour separately. */
export type ProseDiagnosticCategory = "spelling" | "grammar" | "punctuation" | "typography" | "word" | "style";

/** Most serious first; the badge takes the colour of the first present. */
export const PROSE_CATEGORY_ORDER: readonly ProseDiagnosticCategory[] = [
  "spelling", "grammar", "punctuation", "word", "typography", "style",
];

export type ProseDiagnostic = {
  source: ProseDiagnosticSource;
  from: number;
  to: number;
  severity?: "info" | "warning" | "error";
  category?: ProseDiagnosticCategory;
  categoryLabel?: string;
  title?: string;
  message: string;
  rule?: string;
  ruleDescription?: string;
  url?: string;
  word?: string;
  suggestions?: readonly string[];
};

export const setProseDiagnosticsEffect = StateEffect.define<readonly ProseDiagnostic[]>();
/** Mark the diagnostic whose card is open, or clear the mark with null. */
export const setActiveProseDiagnosticEffect = StateEffect.define<{ from: number; to: number } | null>();

export function proseDiagnosticCategory(diag: ProseDiagnostic): ProseDiagnosticCategory {
  if (diag.category) return diag.category;
  if (diag.source === "browser") return "spelling";
  return diag.severity === "warning" ? "spelling" : diag.severity === "info" ? "style" : "grammar";
}

function diagnosticTouched(diag: ProseDiagnostic, tr: Transaction): boolean {
  let touched = false;
  tr.changes.iterChanges((fromA, toA) => {
    if (touched) return;
    if (fromA === toA) {
      touched = fromA > diag.from && fromA < diag.to;
      return;
    }
    touched = fromA < diag.to && toA > diag.from;
  });
  return touched;
}

export const proseDiagnosticsField = StateField.define<readonly ProseDiagnostic[]>({
  create: () => [],
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setProseDiagnosticsEffect)) {
        return [...effect.value]
          .filter((diag) => Number.isFinite(diag.from) && Number.isFinite(diag.to) && diag.from < diag.to)
          .sort((a, b) => a.from - b.from || a.to - b.to || a.source.localeCompare(b.source));
      }
    }
    if (!tr.docChanged || value.length === 0) return value;
    return value
      .filter((diag) => !diagnosticTouched(diag, tr))
      .map((diag) => ({
        ...diag,
        from: tr.changes.mapPos(diag.from, 1),
        to: tr.changes.mapPos(diag.to, -1),
      }))
      .filter((diag) => diag.from < diag.to);
  },
});

const activeProseDiagnosticField = StateField.define<{ from: number; to: number } | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setActiveProseDiagnosticEffect)) return effect.value;
      if (effect.is(setProseDiagnosticsEffect)) value = null;
    }
    if (!value || !tr.docChanged) return value;
    const from = tr.changes.mapPos(value.from, 1);
    const to = tr.changes.mapPos(value.to, -1);
    return from < to ? { from, to } : null;
  },
});

export const PROSE_CATEGORY_LABELS: Record<ProseDiagnosticCategory, string> = {
  spelling: "Spelling",
  grammar: "Grammar",
  punctuation: "Punctuation",
  typography: "Typography",
  word: "Word choice",
  style: "Style",
};

export function proseDiagnosticLabel(diag: ProseDiagnostic): string {
  return PROSE_CATEGORY_LABELS[proseDiagnosticCategory(diag)];
}

function diagnosticMark(diag: ProseDiagnostic, active: boolean): Decoration {
  const category = proseDiagnosticCategory(diag);
  return Decoration.mark({
    class: `cm-prose-diagnostic cm-prose-diagnostic-${diag.source} cm-prose-${category}`
      + (active ? " cm-prose-diagnostic-active" : ""),
    attributes: {
      title: `${proseDiagnosticLabel(diag)}: ${diag.title || diag.message}`,
      "data-prose-source": diag.source,
      "data-prose-category": category,
    },
  });
}

const proseDiagnosticDecorations = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    const diagnostics = tr.state.field(proseDiagnosticsField, false);
    const previous = tr.startState.field(proseDiagnosticsField, false);
    const active = tr.state.field(activeProseDiagnosticField, false) ?? null;
    const previousActive = tr.startState.field(activeProseDiagnosticField, false) ?? null;
    if (diagnostics === previous && active === previousActive) {
      return tr.docChanged ? value.map(tr.changes) : value;
    }
    return Decoration.set((diagnostics ?? []).map((diag) => diagnosticMark(
      diag,
      !!active && diag.from === active.from && diag.to === active.to,
    ).range(diag.from, diag.to)), true);
  },
  provide: (field) => EditorView.decorations.from(field),
});

export const proseDiagnosticsExtension = [
  proseDiagnosticsField,
  activeProseDiagnosticField,
  proseDiagnosticDecorations,
];

export function setActiveProseDiagnostic(view: EditorView, diag: ProseDiagnostic | null): void {
  view.dispatch({ effects: setActiveProseDiagnosticEffect.of(diag ? { from: diag.from, to: diag.to } : null) });
}

/**
 * The diagnostic after (or before) POS, wrapping around the document.  A
 * diagnostic that contains POS is skipped so repeating the command advances.
 */
export function adjacentProseDiagnostic(
  view: EditorView,
  pos: number,
  direction: 1 | -1,
): ProseDiagnostic | null {
  const diagnostics = view.state.field(proseDiagnosticsField, false) ?? [];
  if (diagnostics.length === 0) return null;
  if (direction > 0) return diagnostics.find((diag) => diag.from > pos) ?? diagnostics[0]!;
  for (let index = diagnostics.length - 1; index >= 0; index--) {
    if (diagnostics[index]!.to < pos) return diagnostics[index]!;
  }
  return diagnostics[diagnostics.length - 1]!;
}

export function setProseDiagnostics(view: EditorView, diagnostics: readonly ProseDiagnostic[]): void {
  view.dispatch({ effects: setProseDiagnosticsEffect.of(diagnostics) });
}

export function proseDiagnosticsAt(view: EditorView, pos: number): ProseDiagnostic[] {
  const diagnostics = view.state.field(proseDiagnosticsField, false) ?? [];
  return diagnostics
    .filter((diag) => pos >= diag.from && pos <= diag.to)
    .sort((a, b) => a.from - b.from || b.to - a.to || a.source.localeCompare(b.source));
}

export function allProseDiagnostics(view: EditorView): readonly ProseDiagnostic[] {
  return view.state.field(proseDiagnosticsField, false) ?? [];
}
