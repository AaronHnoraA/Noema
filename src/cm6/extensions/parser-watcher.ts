/*
 * Adapted from Overleaf:
 * services/web/frontend/js/features/source-editor/extensions/wait-for-parser.ts
 * upstream commit 28ad3b03b71cb4311decdcb55c36b33ec10d72db
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { syntaxTreeAvailable } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

type ParseTarget = number | ((view: EditorView) => number);
type ParserWait = { upTo?: ParseTarget; resolve: () => void };

export const parserWatcher = ViewPlugin.fromClass(class {
  private waits: ParserWait[] = [];
  readonly view: EditorView;

  constructor(view: EditorView) {
    this.view = view;
  }

  private ready(wait: ParserWait, state: EditorState): boolean {
    const upTo = typeof wait.upTo === "function" ? wait.upTo(this.view) : wait.upTo;
    return syntaxTreeAvailable(state, upTo);
  }

  wait(upTo?: ParseTarget): Promise<void> {
    return new Promise((resolve) => {
      const wait = { upTo, resolve };
      if (this.ready(wait, this.view.state)) resolve();
      else this.waits.push(wait);
    });
  }

  update(update: ViewUpdate): void {
    const pending: ParserWait[] = [];
    for (const wait of this.waits) {
      if (this.ready(wait, update.state)) wait.resolve();
      else pending.push(wait);
    }
    this.waits = pending;
  }

  destroy(): void {
    // A destroyed view can never parse further. Resolve waiters so callers do
    // not retain the whole editor through an orphan Promise.
    for (const wait of this.waits) wait.resolve();
    this.waits = [];
  }
});

export function waitForParser(view: EditorView, upTo?: ParseTarget): Promise<void> {
  const watcher = view.plugin(parserWatcher);
  if (!watcher) throw new Error("Noema parser watcher extension is not installed");
  return watcher.wait(upTo);
}
