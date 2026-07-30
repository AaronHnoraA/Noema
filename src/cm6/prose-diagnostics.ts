import { StateEffect, StateField, type Transaction } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";

export type ProseDiagnosticSource = "languagetool" | "browser";

export type ProseDiagnostic = {
  source: ProseDiagnosticSource;
  from: number;
  to: number;
  severity?: "info" | "warning" | "error";
  message: string;
  rule?: string;
  word?: string;
  suggestions?: readonly string[];
};

export const setProseDiagnosticsEffect = StateEffect.define<readonly ProseDiagnostic[]>();

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

const proseDiagnosticDecorations = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    const diagnostics = tr.state.field(proseDiagnosticsField, false);
    const previous = tr.startState.field(proseDiagnosticsField, false);
    if (diagnostics === previous && !tr.docChanged) return value;
    return Decoration.set((diagnostics ?? []).map((diag) => Decoration.mark({
      class: `cm-prose-diagnostic cm-prose-diagnostic-${diag.source}`,
      attributes: {
        title: `${diag.source}: ${diag.message}`,
        "data-prose-source": diag.source,
      },
    }).range(diag.from, diag.to)), true);
  },
  provide: (field) => EditorView.decorations.from(field),
});

export const proseDiagnosticsExtension = [
  proseDiagnosticsField,
  proseDiagnosticDecorations,
];

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
