import { StateEffect, StateField } from "@codemirror/state";
import type { Range } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { blockMathRangesOverlapping, mergeOverlappingRanges, rangeOverlapsAny } from "./math-ranges.ts";
import { scanCodeRanges } from "./code-ranges.ts";
import { scanInlineMathRanges } from "../inline-math.ts";
import { hasViewportDecorationRefresh } from "./viewport-refresh.ts";
import { isStableWikiHref, scanWikiLinks, splitWikiFragmentTarget } from "../../shared/wiki-link.mjs";

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

/**
 * The pages that exist, by stable ID, with their current titles.
 *
 * A stable link names its target by ID so that a rename cannot break it. The
 * ID says nothing to a reader, so a link written without a label,
 * `[[roam://<id>]]`, is shown under the page's current title; the source keeps
 * the ID and shows it again as soon as the selection touches the link. An ID
 * that no page answers to is marked broken. Title links are not judged here:
 * what a title resolves to is the index's decision (source repository first,
 * namespaces, aliases), and guessing it in the editor would mark good links.
 *
 * `null` means the index has not been loaded: nothing is replaced or marked.
 */
export const setWikiPageTitles = StateEffect.define<ReadonlyMap<string, string> | null>();

const wikiPageTitlesField = StateField.define<ReadonlyMap<string, string> | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setWikiPageTitles)) value = effect.value;
    return value;
  },
});

/** The page ID a stable target (`roam://<id>#fragment`) points at. */
export function stableWikiTargetId(target: string): string {
  if (!isStableWikiHref(target)) return "";
  const page = splitWikiFragmentTarget(target).pageTarget
    .replace(/^roam:\/\/(?:id\/)?/i, "")
    .split(/[?@]/, 1)[0] ?? "";
  try {
    return decodeURIComponent(page).trim().toLowerCase();
  } catch {
    return page.trim().toLowerCase();
  }
}

class WikiPageTitleWidget extends WidgetType {
  private readonly title: string;
  private readonly fragment: string;

  constructor(title: string, fragment: string) {
    super();
    this.title = title;
    this.fragment = fragment;
  }

  override eq(other: WikiPageTitleWidget): boolean {
    return other.title === this.title && other.fragment === this.fragment;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-link-text cm-internal-link-text cm-roam-link-text cm-roam-link-stable cm-roam-link-title";
    span.textContent = this.fragment ? `${this.title} › ${this.fragment}` : this.title;
    return span;
  }

  // A click on the title is a click on the link: let the editor place the
  // selection and the link handlers see it.
  override ignoreEvent(): boolean {
    return false;
  }
}

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

type LinkStatusBuild = { decorations: DecorationSet; titled: boolean };

function buildBrokenLinkDecorations(view: EditorView): LinkStatusBuild {
  const knownRefs = view.state.field(knownRoamRefsField, false);
  const known = knownRefs && knownRefs.size > 0 ? knownRefs : null;
  const titles = view.state.field(wikiPageTitlesField, false) ?? null;
  if (!known && !titles) return { decorations: Decoration.none, titled: false };
  const selection = view.state.selection;
  let titled = false;
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
    for (const wiki of scanWikiLinks(text, visibleFrom)) {
      const from = wiki.labelFrom;
      const to = wiki.labelTo;
      if (from >= to || rangeOverlapsAny(wiki.from, wiki.to, excludedRanges)) continue;
      const stableId = titles ? stableWikiTargetId(wiki.target) : "";
      if (stableId) {
        const title = titles!.get(stableId);
        if (title == null) {
          decos.push(mark.range(from, to));
        } else if (!wiki.explicitLabel) {
          titled = true;
          // The raw ID stays editable while the selection touches the link.
          if (selection.ranges.some((range) => range.from <= wiki.to && range.to >= wiki.from)) continue;
          decos.push(Decoration.replace({
            widget: new WikiPageTitleWidget(title, splitWikiFragmentTarget(wiki.target).fragment),
          }).range(from, to));
        }
        continue;
      }
      if (known && !knownRefMatches(known, wiki.target)) decos.push(mark.range(from, to));
    }
    if (!known) continue;

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

  return { decorations: Decoration.set(decos, true), titled };
}

class RoamLinkStatusPlugin {
  decorations: DecorationSet;
  // Whether the visible text holds a link shown under its page title; only
  // then does moving the selection change what is drawn.
  private titled: boolean;

  constructor(view: EditorView) {
    const built = buildBrokenLinkDecorations(view);
    this.decorations = built.decorations;
    this.titled = built.titled;
  }

  update(update: ViewUpdate): void {
    if (
      update.docChanged
      || update.viewportChanged
      || hasViewportDecorationRefresh(update)
      || update.startState.field(knownRoamRefsField, false) !== update.state.field(knownRoamRefsField, false)
      || update.startState.field(wikiPageTitlesField, false) !== update.state.field(wikiPageTitlesField, false)
      || (this.titled && update.selectionSet)
    ) {
      const built = buildBrokenLinkDecorations(update.view);
      this.decorations = built.decorations;
      this.titled = built.titled;
    }
  }
}

const roamLinkStatusPlugin = ViewPlugin.fromClass(RoamLinkStatusPlugin, {
  decorations: (plugin) => plugin.decorations,
});

export const roamLinkStatusExtension = [knownRoamRefsField, wikiPageTitlesField, roamLinkStatusPlugin];
