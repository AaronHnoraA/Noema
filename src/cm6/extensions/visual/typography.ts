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

export const VISUAL_TYPOGRAPHY_TARGET_CHARS = 95;
export const VISUAL_TYPOGRAPHY_MIN_GUTTER_RATIO = 0.04;
export const VISUAL_TYPOGRAPHY_MAX_GUTTER_RATIO = 0.08;
export const VISUAL_TYPOGRAPHY_INLINE_GUTTER =
  `clamp(max(var(--aaron-prose-gutter-floor), calc(var(--content-width) * ${VISUAL_TYPOGRAPHY_MIN_GUTTER_RATIO})), calc((var(--content-width) - ${VISUAL_TYPOGRAPHY_TARGET_CHARS}ch) / 2), calc(var(--content-width) * ${VISUAL_TYPOGRAPHY_MAX_GUTTER_RATIO}))`;

/** Mirror the CSS clamp so tests and packaged smoke can audit the actual measure. */
export function visualTypographyGutterPx(
  contentWidthPx: number,
  chWidthPx: number,
  gutterFloorPx = 32,
): number {
  const minimum = Math.max(
    gutterFloorPx,
    contentWidthPx * VISUAL_TYPOGRAPHY_MIN_GUTTER_RATIO,
  );
  const preferred = (
    contentWidthPx - VISUAL_TYPOGRAPHY_TARGET_CHARS * chWidthPx
  ) / 2;
  const maximum = contentWidthPx * VISUAL_TYPOGRAPHY_MAX_GUTTER_RATIO;
  return Math.max(minimum, Math.min(preferred, maximum));
}

export type VisualTypographyAudit = {
  installed: boolean;
  contentWidthPx: number;
  gutterStartPx: number;
  gutterEndPx: number;
  gutterFloorPx: number;
  targetCharacters: number;
  targetMeasurePx: number;
  expectedGutterPx: number;
  matchesContract: boolean;
};

function finiteCssPixels(value: string): number | null {
  const trimmed = value.trim();
  if (!/^-?(?:\d+|\d*\.\d+)px$/.test(trimmed)) return null;
  const parsed = Number.parseFloat(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function roundedPixels(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

/** Read production layout without changing CM state or note content. */
export function auditVisualTypography(root: ParentNode = document): VisualTypographyAudit {
  const editor = root.querySelector<HTMLElement>(".cm-editor.aaronnote-visual-typography");
  const content = editor?.querySelector<HTMLElement>(".cm-content");
  const ownerDocument = editor?.ownerDocument;
  const ownerWindow = ownerDocument?.defaultView;
  if (!editor || !content || !ownerDocument || !ownerWindow) {
    return {
      installed: false,
      contentWidthPx: 0,
      gutterStartPx: 0,
      gutterEndPx: 0,
      gutterFloorPx: 0,
      targetCharacters: VISUAL_TYPOGRAPHY_TARGET_CHARS,
      targetMeasurePx: 0,
      expectedGutterPx: 0,
      matchesContract: false,
    };
  }

  const editorStyle = ownerWindow.getComputedStyle(editor);
  const contentStyle = ownerWindow.getComputedStyle(content);
  const contentWidthPx = finiteCssPixels(editorStyle.getPropertyValue("--content-width"))
    ?? content.getBoundingClientRect().width;
  const gutterStartPx = finiteCssPixels(contentStyle.paddingInlineStart)
    ?? finiteCssPixels(contentStyle.paddingLeft)
    ?? 0;
  const gutterEndPx = finiteCssPixels(contentStyle.paddingInlineEnd)
    ?? finiteCssPixels(contentStyle.paddingRight)
    ?? 0;
  const gutterFloorPx = finiteCssPixels(editorStyle.getPropertyValue("--aaron-prose-gutter-floor")) ?? 32;

  const measure = ownerDocument.createElement("span");
  measure.setAttribute("aria-hidden", "true");
  Object.assign(measure.style, {
    display: "block",
    position: "fixed",
    visibility: "hidden",
    pointerEvents: "none",
    inset: "0 auto auto -100000px",
    boxSizing: "content-box",
    width: `${VISUAL_TYPOGRAPHY_TARGET_CHARS}ch`,
    padding: "0",
    border: "0",
    fontFamily: contentStyle.fontFamily,
    fontSize: contentStyle.fontSize,
    fontStyle: contentStyle.fontStyle,
    fontWeight: contentStyle.fontWeight,
    fontStretch: contentStyle.fontStretch,
    letterSpacing: contentStyle.letterSpacing,
  });
  ownerDocument.body.append(measure);
  const targetMeasurePx = measure.getBoundingClientRect().width;
  measure.remove();

  const chWidthPx = targetMeasurePx / VISUAL_TYPOGRAPHY_TARGET_CHARS;
  const expectedGutterPx = visualTypographyGutterPx(contentWidthPx, chWidthPx, gutterFloorPx);
  const tolerancePx = 1;
  const matchesContract = contentWidthPx > 0
    && targetMeasurePx > 0
    && Math.abs(gutterStartPx - expectedGutterPx) <= tolerancePx
    && Math.abs(gutterEndPx - expectedGutterPx) <= tolerancePx;

  return {
    installed: true,
    contentWidthPx: roundedPixels(contentWidthPx),
    gutterStartPx: roundedPixels(gutterStartPx),
    gutterEndPx: roundedPixels(gutterEndPx),
    gutterFloorPx: roundedPixels(gutterFloorPx),
    targetCharacters: VISUAL_TYPOGRAPHY_TARGET_CHARS,
    targetMeasurePx: roundedPixels(targetMeasurePx),
    expectedGutterPx: roundedPixels(expectedGutterPx),
    matchesContract,
  };
}

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
    "--visual-inline-gutter": VISUAL_TYPOGRAPHY_INLINE_GUTTER,
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
