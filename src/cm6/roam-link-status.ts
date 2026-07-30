import { StateEffect, StateField } from "@codemirror/state";
import type { Range } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { blockMathRangesOverlapping, mergeOverlappingRanges, rangeOverlapsAny } from "./math-ranges.ts";
import { scanCodeRanges } from "./code-ranges.ts";
import { scanInlineMathRanges } from "../inline-math.ts";
import { hasViewportDecorationRefresh } from "./viewport-refresh.ts";

const WIKILINK_RE = /\[\[([^\]\n]+)\]\]/g;
const BARE_ROAM_RE = /\broam:\/\/[^\s<>)\]]+/gi;

export const setKnownRoamRefs = StateEffect.define<readonly string[] | null>();

const knownRoamRefsField = StateField.define<Set<string> | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setKnownRoamRefs)) {
        value = effect.value == null
          ? null
          : new Set(effect.value.map(canonicalNoteRef).filter(Boolean));
      }
    }
    return value;
  },
});

function canonicalNoteRef(value: string): string {
  return String(value || "")
    .trim()
    .replace(/^roam:\/\//i, "")
    .replace(/^\/+/, "")
    .replace(/\\/g, "/")
    .replace(/\.html$/i, ".md")
    .toLowerCase();
}

function refFromRoamHref(href: string): string {
  const raw = href.replace(/^roam:\/\//i, "");
  const ref = raw.split(/[?#@]/, 1)[0] || "";
  try {
    return decodeURIComponent(ref);
  } catch {
    return ref;
  }
}

function knownRefMatches(known: Set<string>, ref: string): boolean {
  const target = canonicalNoteRef(ref);
  if (!target) return true;
  return known.has(target);
}

function buildBrokenLinkDecorations(view: EditorView): DecorationSet {
  const known = view.state.field(knownRoamRefsField, false);
  if (!known || known.size === 0) return Decoration.none;
  const decos: Range<Decoration>[] = [];
  const mark = Decoration.mark({ class: "cm-roam-link-broken" });
  const visibleRanges = view.visibleRanges;
  const excludedRanges = mergeOverlappingRanges([
    ...blockMathRangesOverlapping(view.state, visibleRanges).map(({ from, to }) => ({ from, to })),
    ...visibleRanges.flatMap(({ from, to }) =>
      scanInlineMathRanges(view.state.doc.sliceString(from, to), from)),
    ...scanCodeRanges(view.state, visibleRanges),
  ]);

  for (const { from: visibleFrom, to: visibleTo } of visibleRanges) {
    const text = view.state.doc.sliceString(visibleFrom, visibleTo);
    WIKILINK_RE.lastIndex = 0;
    let wiki: RegExpExecArray | null;
    while ((wiki = WIKILINK_RE.exec(text)) !== null) {
      const ref = wiki[1]?.trim() ?? "";
      if (knownRefMatches(known, ref)) continue;
      const from = visibleFrom + wiki.index + 2;
      const to = visibleFrom + wiki.index + wiki[0].length - 2;
      if (rangeOverlapsAny(from, to, excludedRanges)) continue;
      if (from < to) decos.push(mark.range(from, to));
    }

    BARE_ROAM_RE.lastIndex = 0;
    let roam: RegExpExecArray | null;
    while ((roam = BARE_ROAM_RE.exec(text)) !== null) {
      const href = roam[0].replace(/[.,;:!?]+$/, "");
      const ref = refFromRoamHref(href);
      if (knownRefMatches(known, ref)) continue;
      const from = visibleFrom + roam.index;
      const to = from + href.length;
      if (rangeOverlapsAny(from, to, excludedRanges)) continue;
      decos.push(mark.range(from, to));
    }
  }

  return Decoration.set(decos, true);
}

class RoamLinkStatusPlugin {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = buildBrokenLinkDecorations(view);
  }

  update(update: ViewUpdate): void {
    if (
      update.docChanged
      || update.viewportChanged
      || hasViewportDecorationRefresh(update)
      || update.startState.field(knownRoamRefsField, false) !== update.state.field(knownRoamRefsField, false)
    ) {
      this.decorations = buildBrokenLinkDecorations(update.view);
    }
  }
}

const roamLinkStatusPlugin = ViewPlugin.fromClass(RoamLinkStatusPlugin, {
  decorations: (plugin) => plugin.decorations,
});

export const roamLinkStatusExtension = [knownRoamRefsField, roamLinkStatusPlugin];
