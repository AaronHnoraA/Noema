import type { Editor } from "../../../src/editor-api.ts";
import type { RendererActivityState } from "../../../src/renderer-activity.ts";
import { CoalescedTimer } from "../../../src/coalesced-timer.ts";
import {
  accumulateWritingStatsRange,
  countWritingStats,
  createWritingStatsCounter,
  headingSubtreeRange,
  type WritingStats,
} from "../../writing-stats.ts";
import {
  orgMetaSummaryRangeFromLines,
  type MetaSummarySourceRange,
} from "../../../src/org-meta.ts";

export type WritingStatsController = {
  schedule: (documentChanged: boolean) => void;
  setActivity: (state: RendererActivityState) => void;
  updateNow: () => void;
  isDocumentChanged: () => boolean;
  destroy: () => void;
};

const LARGE_DOCUMENT_CHARS = 512 * 1024;
const UPDATE_DELAY_MS = 300;
const LARGE_UPDATE_DELAY_MS = 900;
const SELECTION_DELAY_MS = 80;

export function createWritingStatsController(
  editor: Editor,
  label: HTMLElement,
): WritingStatsController {
  let cachedDoc: typeof editor.view.state.doc | null = null;
  let metaSummaryRange: MetaSummarySourceRange | null = null;
  let full: WritingStats = { words: 0, characters: 0, cjkCharacters: 0, nonCjkWords: 0 };
  let subtreeCache: {
    doc: typeof editor.view.state.doc;
    from: number;
    to: number;
    stats: WritingStats;
  } | null = null;
  const timer = new CoalescedTimer(UPDATE_DELAY_MS);
  let idleHandle: number | null = null;
  const numberFormat = new Intl.NumberFormat();
  const setBrowserTimeout = (callback: () => void, delay: number): number => window.setTimeout(callback, delay);
  const clearBrowserTimeout = (handle: number): void => window.clearTimeout(handle);
  let destroyed = false;
  let workEpoch = 0;
  let activityState: RendererActivityState = "active";
  let pendingUpdate = false;
  let pendingDelay = UPDATE_DELAY_MS;
  let timerPending = false;

  function canRunBackgroundWork(): boolean {
    return activityState === "active" || activityState === "recently-active";
  }

  function render(
    primary: WritingStats,
    hasSelection: boolean,
    subtree: { from: number; to: number } | null,
    subtreeStats: WritingStats | null,
    selection: { from: number; to: number },
  ): void {
    const scope = hasSelection ? "选区" : "全文";
    const parts = [`${scope} ${numberFormat.format(primary.words)} 字`];
    if (subtree && subtreeStats && (!hasSelection || subtree.from !== selection.from || subtree.to !== selection.to)) {
      parts.push(`本节 ${numberFormat.format(subtreeStats.words)} 字`);
    }
    label.textContent = parts.join(" · ");
    label.title = "字数按中日韩字符和其他语言单词统计";
  }

  /**
   * Recount for the current document and selection.
   *
   * The selection scope goes through the same size rule as the document scope.
   * It used to be counted inline no matter how large it was, which made a
   * pointer drag across a big note re-scan megabytes every 80ms — synchronously,
   * on the main thread, and thrown away by the next drag event. On a document of
   * a few megabytes that alone is enough to stop the surface responding.
   */
  function updateNow(): void {
    if (destroyed) return;
    const state = editor.view.state;
    if (state.doc !== cachedDoc) {
      metaSummaryRange = orgMetaSummaryRangeFromLines(state.doc);
      full = countWritingStats(state.doc, 0, state.doc.length, metaSummaryRange);
      cachedDoc = state.doc;
      subtreeCache = null;
    }
    renderLargeDocumentScopes(workEpoch, state.doc, () => { pendingUpdate = false; });
  }

  function cancelIdle(): void {
    if (idleHandle === null) return;
    if (typeof window.cancelIdleCallback === "function") window.cancelIdleCallback(idleHandle);
    else clearBrowserTimeout(idleHandle);
    idleHandle = null;
  }

  function requestIdle(callback: (deadline: IdleDeadline | null) => void): void {
    cancelIdle();
    if (typeof window.requestIdleCallback === "function") {
      idleHandle = window.requestIdleCallback((deadline) => {
        idleHandle = null;
        callback(deadline);
      }, { timeout: 200 });
    } else {
      idleHandle = setBrowserTimeout(() => {
        idleHandle = null;
        callback(null);
      }, 50);
    }
  }

  function scanRange(
    epoch: number,
    scanDoc: typeof editor.view.state.doc,
    from: number,
    to: number,
    metaRange: MetaSummarySourceRange | null,
    done: (stats: WritingStats) => void,
  ): void {
    let nextPosition = from;
    const counter = createWritingStatsCounter();
    const step = (deadline: IdleDeadline | null): void => {
      if (destroyed || epoch !== workEpoch || editor.view.state.doc !== scanDoc) return;
      const started = performance.now();
      let chunks = 0;
      while (nextPosition < to) {
        let batchTo = Math.min(to, nextPosition + 32 * 1024);
        if (batchTo < to && /[\uD800-\uDBFF]/u.test(scanDoc.sliceString(batchTo - 1, batchTo))) batchTo--;
        accumulateWritingStatsRange(counter, scanDoc, nextPosition, batchTo, metaRange);
        nextPosition = batchTo;
        chunks += 1;
        const inputPending = (navigator as Navigator & {
          scheduling?: { isInputPending?: () => boolean };
        }).scheduling?.isInputPending?.() ?? false;
        if (inputPending || chunks >= 4 || performance.now() - started >= 6
            || (deadline && deadline.timeRemaining() <= 1)) break;
      }
      if (nextPosition < to) requestIdle(step);
      else done(counter.value());
    };
    requestIdle(step);
  }

  function renderLargeDocumentScopes(
    epoch: number,
    scanDoc: typeof editor.view.state.doc,
    onComplete: () => void,
  ): void {
    if (destroyed || epoch !== workEpoch || editor.view.state.doc !== scanDoc) return;
    const state = editor.view.state;
    const selection = state.selection.main;
    const hasSelection = selection.from !== selection.to;
    const subtree = headingSubtreeRange(state, selection.head);

    const finish = (primary: WritingStats, subtreeStats: WritingStats | null): void => {
      if (destroyed || epoch !== workEpoch || editor.view.state.doc !== scanDoc) return;
      render(primary, hasSelection, subtree, subtreeStats, selection);
      onComplete();
    };
    const resolveSubtree = (primary: WritingStats): void => {
      if (!subtree) return finish(primary, null);
      if (
        subtreeCache?.doc === scanDoc
        && subtreeCache.from === subtree.from
        && subtreeCache.to === subtree.to
      ) return finish(primary, subtreeCache.stats);
      if (subtree.from === 0 && subtree.to === scanDoc.length) return finish(primary, full);
      if (subtree.to - subtree.from < LARGE_DOCUMENT_CHARS) {
        const stats = countWritingStats(scanDoc, subtree.from, subtree.to, metaSummaryRange);
        subtreeCache = { doc: scanDoc, ...subtree, stats };
        return finish(primary, stats);
      }
      scanRange(epoch, scanDoc, subtree.from, subtree.to, metaSummaryRange, (stats) => {
        subtreeCache = { doc: scanDoc, ...subtree, stats };
        finish(primary, stats);
      });
    };

    if (!hasSelection) return resolveSubtree(full);
    if (selection.to - selection.from < LARGE_DOCUMENT_CHARS) {
      return resolveSubtree(countWritingStats(scanDoc, selection.from, selection.to, metaSummaryRange));
    }
    scanRange(epoch, scanDoc, selection.from, selection.to, metaSummaryRange, resolveSubtree);
  }

  function queueIdle(): void {
    if (destroyed || !canRunBackgroundWork()) return;
    const epoch = ++workEpoch;
    const state = editor.view.state;
    if (state.doc === cachedDoc || state.doc.length < LARGE_DOCUMENT_CHARS) {
      requestIdle(() => {
        if (destroyed || epoch !== workEpoch || !canRunBackgroundWork()) return;
        updateNow();
        pendingUpdate = false;
      });
      return;
    }
    const scanDoc = state.doc;
    metaSummaryRange = orgMetaSummaryRangeFromLines(scanDoc);
    scanRange(epoch, scanDoc, 0, scanDoc.length, metaSummaryRange, (stats) => {
      if (destroyed || epoch !== workEpoch || editor.view.state.doc !== scanDoc) return;
      full = stats;
      cachedDoc = scanDoc;
      subtreeCache = null;
      renderLargeDocumentScopes(epoch, scanDoc, () => {
        if (epoch === workEpoch && canRunBackgroundWork()) pendingUpdate = false;
      });
    });
  }

  function armPending(delay: number): void {
    timer.cancel();
    timerPending = true;
    timer.schedule(() => {
      timerPending = false;
      queueIdle();
    }, undefined, delay);
  }

  function schedule(documentChanged: boolean): void {
    if (destroyed) return;
    cancelIdle();
    workEpoch++;
    pendingUpdate = true;
    pendingDelay = documentChanged
      ? (editor.getMarkdownLength() >= LARGE_DOCUMENT_CHARS ? LARGE_UPDATE_DELAY_MS : UPDATE_DELAY_MS)
      : SELECTION_DELAY_MS;
    timerPending = false;
    if (!canRunBackgroundWork()) return;
    armPending(pendingDelay);
  }

  function setActivity(state: RendererActivityState): void {
    if (destroyed) return;
    const wasSuspended = activityState === "quiescent" || activityState === "hidden";
    activityState = state;
    if (state === "destroyed") {
      destroyed = true;
      workEpoch++;
      timer.cancel();
      timerPending = false;
      cancelIdle();
      return;
    }
    if (state === "quiescent" || state === "hidden") {
      if (timerPending || idleHandle !== null) pendingUpdate = true;
      workEpoch++;
      timer.cancel();
      timerPending = false;
      cancelIdle();
      return;
    }
    if (wasSuspended && pendingUpdate && canRunBackgroundWork()) {
      // Resume exactly once from the current document/selection rather than
      // replaying the delay that expired while the renderer was quiescent.
      armPending(0);
    }
  }

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    activityState = "destroyed";
    workEpoch++;
    pendingUpdate = false;
    timer.cancel();
    timerPending = false;
    cancelIdle();
    cachedDoc = null;
    metaSummaryRange = null;
    subtreeCache = null;
  }

  return {
    schedule,
    setActivity,
    updateNow,
    isDocumentChanged: () => editor.view.state.doc !== cachedDoc,
    destroy,
  };
}
