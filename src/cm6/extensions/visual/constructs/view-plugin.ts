/**
 * The update lifecycle of a viewport construct family, written once.
 *
 * A family drawn by a ViewPlugin — inline chips, images, `@@` commands, wiki
 * titles — rebuilds its decorations only when something it draws can have
 * changed, and does so the same way everywhere:
 *
 * - a selection move during input-method composition changes nothing;
 * - a typing burst maps the decorations instead of rebuilding (the family may
 *   map its own state too, or refuse, which forces a rebuild);
 * - pointer selection alone settles when the button is released;
 * - a document, viewport or refresh change rebuilds using the selection at mousedown;
 * - a selection change rebuilds only if it changed which constructs are open
 *   (`revealKey`), and so does Vim pinning or releasing objects;
 * - the decorations survive the plugin being recreated (visual-mode toggles)
 *   through the persistent visual state cache.
 *
 * A family supplies `build` and, where it has them, `revealKey`, extra
 * invalidation, side effects and state of its own.
 */

import type { Extension } from "@codemirror/state";
import { ViewPlugin, type DecorationSet, type EditorView, type PluginValue, type ViewUpdate } from "@codemirror/view";
import { hasViewportDecorationRefresh } from "../../../viewport-refresh.ts";
import { isPointerSelecting, updateHasPointerSelectionEffect } from "../selection.ts";
import { isCoalescedVisualTyping } from "../typing-burst.ts";
import { rememberPersistentVisualPluginState, restorePersistentVisualPluginState } from "../visual-mode.ts";
import { transactionChangesPinning } from "./mode.ts";

export interface ConstructViewPluginSpec<Extra = undefined> {
  /** The family's decorations for VIEW's viewport. */
  build(view: EditorView, extra: Extra): DecorationSet;
  /**
   * The constructs the selection currently opens; a selection change that
   * keeps the key draws nothing new. Without it, the family ignores selection.
   */
  revealKey?(view: EditorView, extra: Extra): string;
  /** State of the family's own, rebuilt with the decorations (e.g. literal ranges). */
  extra?: {
    create(view: EditorView): Extra;
    /** Map through a typing burst; return null to rebuild instead. */
    map(extra: Extra, update: ViewUpdate): Extra | null;
  };
  /** Map the family's DOM metadata through a typing burst; false forces a rebuild. */
  mapDuringTyping?(update: ViewUpdate): boolean;
  /** Further reasons to rebuild (a field the family reads changed). */
  invalidates?(update: ViewUpdate): boolean;
  /** Side effects every update needs before any of the above. */
  beforeUpdate?(update: ViewUpdate): void;
  /** Per-view work while mounted (a subscription); returns its teardown. */
  setup?(view: EditorView): () => void;
  /** Extensions provided with the plugin, typically the family's registry entry. */
  provide?(plugin: ViewPlugin<PluginValue & { decorations: DecorationSet }>): Extension;
}

type Snapshot<Extra> = { decorations: DecorationSet; revealKey: string; extra: Extra };

/** A ViewPlugin running the shared lifecycle; its `decorations` are the family's. */
export function constructViewPlugin<Extra = undefined>(
  spec: ConstructViewPluginSpec<Extra>,
): ViewPlugin<PluginValue & { decorations: DecorationSet }> {
  const cacheKey = {};
  const keyOf = (view: EditorView, extra: Extra): string => spec.revealKey?.(view, extra) ?? "";

  class ConstructViewPlugin {
    decorations: DecorationSet;
    private revealKey: string;
    private extra: Extra;
    private readonly view: EditorView;
    private readonly teardown: () => void;

    constructor(view: EditorView) {
      this.view = view;
      this.teardown = spec.setup?.(view) ?? (() => {});
      const cached = restorePersistentVisualPluginState<Snapshot<Extra>>(view.state, cacheKey);
      this.extra = cached?.extra ?? (spec.extra?.create(view) as Extra);
      this.decorations = cached?.decorations ?? spec.build(view, this.extra);
      this.revealKey = cached?.revealKey ?? keyOf(view, this.extra);
    }

    update(update: ViewUpdate): void {
      spec.beforeUpdate?.(update);
      const selectionOnly = update.selectionSet && !update.docChanged && !update.viewportChanged;
      if (selectionOnly && update.view.compositionStarted) return;
      if (isCoalescedVisualTyping(update) && (spec.mapDuringTyping?.(update) ?? true)) {
        const extra = spec.extra ? spec.extra.map(this.extra, update) : this.extra;
        if (extra !== null) {
          this.extra = extra as Extra;
          this.decorations = this.decorations.map(update.changes);
          return;
        }
      }
      // Only the moving selection is held. A viewport change still draws new
      // constructs, using the mousedown selection for reveal decisions.
      if (selectionOnly && isPointerSelecting(update.state)) return;
      const settled = updateHasPointerSelectionEffect(update) && !isPointerSelecting(update.state);
      const rebuild = update.docChanged || update.viewportChanged || hasViewportDecorationRefresh(update)
        || (spec.invalidates?.(update) ?? false);
      if (rebuild) this.extra = spec.extra ? spec.extra.create(update.view) : this.extra;
      const nextKey = rebuild || update.selectionSet || settled || update.transactions.some(transactionChangesPinning)
        ? keyOf(update.view, this.extra)
        : this.revealKey;
      if (rebuild || nextKey !== this.revealKey) this.decorations = spec.build(update.view, this.extra);
      this.revealKey = nextKey;
    }

    destroy(): void {
      rememberPersistentVisualPluginState<Snapshot<Extra>>(this.view, cacheKey, {
        decorations: this.decorations,
        revealKey: this.revealKey,
        extra: this.extra,
      });
      this.teardown();
    }
  }

  return ViewPlugin.fromClass(ConstructViewPlugin, {
    decorations: (plugin) => plugin.decorations,
    provide: spec.provide ? (plugin) => spec.provide!(plugin) : undefined,
  });
}
