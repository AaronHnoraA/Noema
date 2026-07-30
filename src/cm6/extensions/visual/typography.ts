/*
 * Adapted from Overleaf:
 * services/web/frontend/js/features/source-editor/extensions/visual/visual-theme.ts
 * upstream commit 28ad3b03b71cb4311decdcb55c36b33ec10d72db
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Typography is part of Noema's Visual-mode kernel.  It is deliberately
 * not a host-level resize plugin: CodeMirror already knows when its geometry
 * changes, so the content width is read once from that update and fed back
 * through a compartment.  The annotation prevents that reconfiguration from
 * observing itself.
 */

import {
  Annotation,
  Compartment,
  Facet,
  type Extension,
} from "@codemirror/state";
import { EditorView } from "@codemirror/view";

const contentWidthTheme = new Compartment();
const changeContentWidth = Annotation.define<boolean>();
const currentContentWidth = Facet.define<string, string>({
  combine(values) {
    return values[0] ?? "";
  },
});

function createContentWidthTheme(contentWidth: string): Extension {
  return [
    currentContentWidth.of(contentWidth),
    EditorView.editorAttributes.of({
      class: "aaronnote-visual-typography",
      style: `--content-width: ${contentWidth}`,
    }),
  ];
}

const contentWidthSetter = EditorView.updateListener.of((update) => {
  if (!update.geometryChanged || update.docChanged) return;
  if (update.transactions.some((transaction) => transaction.annotation(changeContentWidth))) return;

  const width = `${update.view.contentDOM.offsetWidth}px`;
  if (update.state.facet(currentContentWidth) === width) return;

  update.view.dispatch({
    effects: contentWidthTheme.reconfigure(createContentWidthTheme(width)),
    // Force a cursor redraw when WebKit does not propagate the geometry change
    // to the selection layer (same workaround as Overleaf #15145).
    selection: update.view.state.selection,
    annotations: changeContentWidth.of(true),
  });
});

const visualTypographyTheme = EditorView.theme({
  "&.cm-editor": {
    "--visual-font-family": "var(--aaron-font-prose)",
    "--visual-font-size": "calc(var(--aaron-prose-size) * var(--aaronnote-layout-zoom, 1))",
    "--visual-inline-gutter":
      "clamp(max(var(--aaron-prose-gutter-floor), calc(var(--content-width) * 0.04)), calc((var(--content-width) - 95ch) / 2), calc(var(--content-width) * 0.08))",
    minWidth: "var(--aaron-prose-layout-floor)",
    fontFamily: "var(--visual-font-family)",
    fontSize: "var(--visual-font-size)",
    lineHeight: "var(--aaron-prose-leading)",
  },
  ".cm-content.cm-content": {
    boxSizing: "border-box",
    width: "100%",
    overflowX: "hidden",
    padding:
      "var(--aaron-prose-page-top) var(--visual-inline-gutter) var(--aaron-prose-page-bottom)",
    fontFamily: "var(--visual-font-family)",
    fontSize: "var(--visual-font-size)",
    lineHeight: "var(--aaron-prose-leading)",
  },
  ".cm-cursor-primary.cm-cursor-primary": {
    fontFamily: "var(--visual-font-family)",
    fontSize: "var(--visual-font-size)",
  },
  ".cm-line": {
    overflowX: "visible",
  },
});

export const visualTypographyExtension: Extension = [
  contentWidthTheme.of(createContentWidthTheme("100%")),
  visualTypographyTheme,
  contentWidthSetter,
];
