import { ChangeSet } from "@codemirror/state";

export type MarkdownTextChange = {
  from: number;
  to: number;
  insert: string;
};

export type MarkdownChangeSetPayload = {
  length: number;
  newLength: number;
  changes: MarkdownTextChange[];
};

export type EditorSaveChangeToken = {
  readonly changeSet: ChangeSet;
  readonly payload: MarkdownChangeSetPayload;
};

export function markdownChangeSetPayload(changeSet: ChangeSet): MarkdownChangeSetPayload {
  const changes: MarkdownTextChange[] = [];
  changeSet.iterChanges((from, to, _newFrom, _newTo, inserted) => {
    changes.push({ from, to, insert: inserted.toString() });
  });
  return {
    length: changeSet.length,
    newLength: changeSet.newLength,
    changes,
  };
}

// CM6 already represents edits as persistent ChangeSets. Compose them while
// the autosave debounce is open, then move exactly that prefix into the
// in-flight request. Edits typed during the request start a new suffix and can
// be composed back onto the prefix if the write fails.
export class EditorSaveChangeTracker {
  private pending: ChangeSet | null = null;

  hasPending(): boolean {
    return Boolean(this.pending && !this.pending.empty);
  }

  record(changeSet: ChangeSet): void {
    if (changeSet.empty) return;
    this.pending = this.pending ? this.pending.compose(changeSet) : changeSet;
  }

  capture(): EditorSaveChangeToken | null {
    const changeSet = this.pending;
    if (!changeSet || changeSet.empty) return null;
    this.pending = null;
    return { changeSet, payload: markdownChangeSetPayload(changeSet) };
  }

  restore(token: EditorSaveChangeToken): boolean {
    try {
      this.pending = this.pending ? token.changeSet.compose(this.pending) : token.changeSet;
      return true;
    } catch {
      // A whole-document reset invalidates the old coordinate space. The
      // caller falls back to one full save instead of risking a bad patch.
      this.pending = null;
      return false;
    }
  }

  reset(): void {
    this.pending = null;
  }
}
