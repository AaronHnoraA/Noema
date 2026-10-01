import { WidgetType, type EditorView } from "@codemirror/view";
import { measuredHeightCache, observeWidget, unobserveWidget } from "./measured-observer.ts";

/**
 * Shared base class for all Noema CM6 widgets.
 *
 * Provides two benefits over bare WidgetType:
 *
 * 1. ResizeObserver — after toDOM() mounts the widget's DOM, any subsequent
 *    height change (lazy image load, async SVG, font reflow, collapse toggle…)
 *    fires a debounced view.requestMeasure().  This keeps CM6's height map
 *    current so posAtCoords() maps clicks to the correct line.
 *
 * 2. estimatedHeight cache — the last measured pixel height is stored by
 *    stable content key.  When CM6 recreates an off-screen widget during
 *    scroll it gets a real estimate instead of -1 (unknown), preventing
 *    height-map thrash that causes click drift to accumulate.
 *
 * Block-level CM6 widgets must not put vertical whitespace in CSS margin.
 * Keep top/bottom spacing inside the measured element with padding or child
 * layout instead, otherwise CodeMirror's height map cannot see it.
 *
 * Usage:
 *   class MyWidget extends MeasuredWidget {
 *     protected measureKey() { return "my:" + this.stableId; }
 *     toDOM(view: EditorView): HTMLElement {
 *       const el = ...build DOM...;
 *       return this.registerMeasured(el, view);  // ← call at every return
 *     }
 *   }
 *
 * For inline widgets (no block height contribution) override measuredBlock:
 *   protected get measuredBlock() { return false; }
 * Then estimatedHeight stays -1; override observeSize to observe inline floats.
 * Block decorations whose contents float must instead override floatedBlock:
 * CM6 measures an in-flow, zero-height anchor, never the floated figure itself.
 *
 * Subclasses with their own destroy() MUST call super.destroy(dom) to
 * unregister from the observer.
 */
export abstract class MeasuredWidget extends WidgetType {
  protected abstract measureKey(): string;

  protected get measuredBlock(): boolean { return true; }

  protected get floatedBlock(): boolean { return false; }

  // Floats contribute no block height at their source line, but changes to
  // their border box still change the width and height of surrounding lines.
  protected get observeSize(): boolean { return this.measuredBlock; }

  protected measureGroupKey(): string | null { return null; }

  protected estimatedHeightFallback(): number { return -1; }

  protected registerMeasured(dom: HTMLElement, view: EditorView): HTMLElement {
    if (this.measuredBlock && !this.floatedBlock) {
      dom.classList.add("cm-aaronnote-measured-widget");
      dom.dataset.cmMeasureKey = this.measureKey();
      const groupKey = this.measureGroupKey();
      if (groupKey) dom.dataset.cmMeasureGroupKey = groupKey;
    }
    if (this.observeSize) observeWidget(dom, view);
    if (this.floatedBlock) {
      const anchor = document.createElement("div");
      anchor.className = "cm-float-anchor";
      anchor.append(dom);
      return anchor;
    }
    return dom;
  }

  get estimatedHeight(): number {
    if (this.floatedBlock) return 0;
    if (!this.measuredBlock) return -1;
    const exact = measuredHeightCache.get(this.measureKey());
    if (exact !== undefined) return exact;
    const groupKey = this.measureGroupKey();
    if (groupKey) {
      const group = measuredHeightCache.get(groupKey);
      if (group !== undefined) return group;
    }
    return this.estimatedHeightFallback();
  }

  destroy(dom: HTMLElement): void {
    if (this.observeSize) {
      const observed = this.floatedBlock ? dom.firstElementChild : dom;
      if (observed instanceof HTMLElement) unobserveWidget(observed);
    }
  }
}
