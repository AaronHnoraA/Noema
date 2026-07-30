import type { Editor } from "../../../src/editor-api.ts";
import { CoalescedTimer } from "../../../src/coalesced-timer.ts";
import {
  countWritingStats,
  headingSubtreeRange,
  type WritingStats,
} from "../../writing-stats.ts";
import {
  orgMetaSummaryRangeFromLines,
  type MetaSummarySourceRange,
} from "../../../src/org-meta.ts";

export type WritingStatsController = {
  schedule: (documentChanged: boolean) => void;
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

  function updateNow(): void {
    if (destroyed) return;
    const state = editor.view.state;
    if (state.doc !== cachedDoc) {
      metaSummaryRange = orgMetaSummaryRangeFromLines(state.doc);
      full = countWritingStats(state.doc, 0, state.doc.length, metaSummaryRange);
      cachedDoc = state.doc;
    }
    const selection = state.selection.main;
    const hasSelection = selection.from !== selection.to;
    const primary = hasSelection
      ? countWritingStats(state.doc, selection.from, selection.to, metaSummaryRange)
      : full;
    const subtree = headingSubtreeRange(state, selection.head);
    let subtreeStats: WritingStats | null = null;
    if (subtree) {
      if (
        subtreeCache?.doc === state.doc
        && subtreeCache.from === subtree.from
        && subtreeCache.to === subtree.to
      ) {
        subtreeStats = subtreeCache.stats;
      } else {
        subtreeStats = subtree.from === 0 && subtree.to === state.doc.length
          ? full
          : countWritingStats(state.doc, subtree.from, subtree.to, metaSummaryRange);
        subtreeCache = { doc: state.doc, ...subtree, stats: subtreeStats };
      }
    }
    const scope = hasSelection ? "选区" : "全文";
    const parts = [`${scope} ${numberFormat.format(primary.words)} 字`];
    if (subtree && subtreeStats && (!hasSelection || subtree.from !== selection.from || subtree.to !== selection.to)) {
      parts.push(`本节 ${numberFormat.format(subtreeStats.words)} 字`);
    }
    label.textContent = parts.join(" · ");
    label.title = "字数按中日韩字符和其他语言单词统计";
  }

  function cancelIdle(): void {
    if (idleHandle === null) return;
    if (typeof window.cancelIdleCallback === "function") window.cancelIdleCallback(idleHandle);
    else clearBrowserTimeout(idleHandle);
    idleHandle = null;
  }

  function queueIdle(): void {
    cancelIdle();
    if (typeof window.requestIdleCallback === "function") {
      idleHandle = window.requestIdleCallback(() => {
        idleHandle = null;
        updateNow();
      });
    } else {
      idleHandle = setBrowserTimeout(() => {
        idleHandle = null;
        updateNow();
      }, 50);
    }
  }

  function schedule(documentChanged: boolean): void {
    if (destroyed) return;
    cancelIdle();
    const delay = documentChanged
      ? (editor.getMarkdownLength() >= LARGE_DOCUMENT_CHARS ? LARGE_UPDATE_DELAY_MS : UPDATE_DELAY_MS)
      : SELECTION_DELAY_MS;
    timer.schedule(queueIdle, undefined, delay);
  }

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    timer.cancel();
    cancelIdle();
    cachedDoc = null;
    metaSummaryRange = null;
    subtreeCache = null;
  }

  return {
    schedule,
    updateNow,
    isDocumentChanged: () => editor.view.state.doc !== cachedDoc,
    destroy,
  };
}
