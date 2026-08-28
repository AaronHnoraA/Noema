import type { Transaction } from "@codemirror/state";
import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";

import { scheduleViewportDecorationRefresh } from "../../viewport-refresh.ts";

/**
 * Cosmetic decoration DOM churn is wasteful in every renderer and is
 * particularly visible when WebKit is embedded in Emacs. Decoration sets are
 * mapped by each participating plugin while text is arriving, then rebuilt
 * once after the burst settles. This is one shared editor policy for Electron,
 * xwidget and browser surfaces—not a host adapter fork.
 */
export function isCoalescedVisualTyping(update: ViewUpdate): boolean {
  if (!update.docChanged) return false;
  return update.transactions.some((transaction) => (
    transaction.isUserEvent("input") || transaction.isUserEvent("delete")
  ));
}

const TYPING_SETTLE_MS = 120;

class VisualTypingBurstPlugin {
  private timer = 0;
  private readonly view: EditorView;

  constructor(view: EditorView) {
    this.view = view;
  }

  update(update: ViewUpdate): void {
    if (!isCoalescedVisualTyping(update)) return;
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = 0;
      scheduleViewportDecorationRefresh(this.view);
    }, TYPING_SETTLE_MS);
  }

  destroy(): void {
    window.clearTimeout(this.timer);
    this.timer = 0;
  }
}

export const visualTypingBurstExtension = ViewPlugin.fromClass(VisualTypingBurstPlugin);

/** Useful to state fields that receive a Transaction instead of a ViewUpdate. */
export function isCoalescedVisualTypingTransaction(transaction: Transaction): boolean {
  if (!transaction.docChanged) return false;
  return transaction.isUserEvent("input") || transaction.isUserEvent("delete");
}
