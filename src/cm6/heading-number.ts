import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";

import {
  headingNumberNeedsSpacing,
  numberHeadings,
  type HeadingNumberFormat,
} from "../heading-number.ts";
import { tocIndexFromState } from "./toc-index.ts";
import { setVisualModeEffect } from "./extensions/visual/visual-mode.ts";

export type HeadingNumberingConfiguration = {
  enabled: boolean;
  format: HeadingNumberFormat;
};

const DEFAULT_CONFIGURATION: HeadingNumberingConfiguration = {
  enabled: false,
  format: "decimal-hierarchical",
};

export const setHeadingNumberingEffect = StateEffect.define<Partial<HeadingNumberingConfiguration>>();

class HeadingNumberWidget extends WidgetType {
  readonly label: string;

  constructor(label: string) {
    super();
    this.label = label;
  }

  eq(other: HeadingNumberWidget): boolean { return this.label === other.label; }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "noema-heading-number";
    span.setAttribute("aria-hidden", "true");
    span.textContent = this.label + (headingNumberNeedsSpacing(this.label) ? " " : "");
    return span;
  }

  ignoreEvent(): boolean { return true; }
}

type HeadingNumberingState = {
  configuration: HeadingNumberingConfiguration;
  visual: boolean;
  decorations: DecorationSet;
};

function decorationsFor(viewState: import("@codemirror/state").EditorState, state: Omit<HeadingNumberingState, "decorations">): DecorationSet {
  if (!state.configuration.enabled || !state.visual) return Decoration.none;
  const headings = tocIndexFromState(viewState).headings;
  const ranges = numberHeadings(headings, state.configuration.format)
    .filter(({ heading }) => heading.source !== "semantic")
    .map(({ heading, label }) => Decoration.widget({
      widget: new HeadingNumberWidget(label),
      side: -1,
    }).range(heading.pos));
  return Decoration.set(ranges, true);
}

function createHeadingNumberingField(initial: HeadingNumberingConfiguration): Extension {
  const field = StateField.define<HeadingNumberingState>({
    create(state) {
      const base = { configuration: initial, visual: true };
      return { ...base, decorations: decorationsFor(state, base) };
    },
    update(previous, transaction) {
      let configuration = previous.configuration;
      let visual = previous.visual;
      let changed = transaction.docChanged;
      for (const effect of transaction.effects) {
        if (effect.is(setHeadingNumberingEffect)) {
          configuration = { ...configuration, ...effect.value };
          changed = true;
        } else if (effect.is(setVisualModeEffect)) {
          visual = effect.value;
          changed = true;
        }
      }
      if (!changed) return previous;
      const base = { configuration, visual };
      return { ...base, decorations: decorationsFor(transaction.state, base) };
    },
    provide: (value) => EditorView.decorations.from(value, (state) => state.decorations),
  });
  return field;
}

export function headingNumberingExtension(
  initial: Partial<HeadingNumberingConfiguration> = {},
): Extension {
  return createHeadingNumberingField({ ...DEFAULT_CONFIGURATION, ...initial });
}

export function setHeadingNumbering(
  view: EditorView,
  configuration: Partial<HeadingNumberingConfiguration>,
): void {
  view.dispatch({ effects: setHeadingNumberingEffect.of(configuration) });
}
