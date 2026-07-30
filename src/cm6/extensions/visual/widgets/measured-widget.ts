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
 * Then registerMeasured is a no-op and estimatedHeight stays -1.
 *
 * Subclasses with their own destroy() MUST call super.destroy(dom) to
 * unregister from the observer.
 */
export abstract class MeasuredWidget extends WidgetType {
  protected abstract measureKey(): string;

  protected get measuredBlock(): boolean { return true; }

  protected measureGroupKey(): string | null { return null; }

  protected estimatedHeightFallback(): number { return -1; }

  protected registerMeasured(dom: HTMLElement, view: EditorView): HTMLElement {
    if (this.measuredBlock) {
      dom.classList.add("cm-aaronnote-measured-widget");
      dom.dataset.cmMeasureKey = this.measureKey();
      const groupKey = this.measureGroupKey();
      if (groupKey) dom.dataset.cmMeasureGroupKey = groupKey;
      observeWidget(dom, view);
    }
    return dom;
  }

  get estimatedHeight(): number {
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
    if (this.measuredBlock) unobserveWidget(dom);
  }
}
