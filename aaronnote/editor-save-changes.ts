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

export type SourceLineEnding = "lf" | "crlf";

/**
 * How a note's file spells its line breaks, and whether CM6 offsets can patch it.
 *
 * CodeMirror keeps every line break as "\n", so a change set's offsets count
 * one unit per break. A file written with "\r\n" (or a stray "\r") has more
 * units than that, and an incremental save against it fails the persistence
 * layer's length check on every attempt — the edits could never be saved.
 * Such a note saves its whole source instead, written back with the line
 * ending the file already used, as MarkText's `loadMarkdownFile` /
 * `writeMarkdownFile` do. Mixed endings settle on the majority.
 */
export function sourceLineEnding(content: string): { eol: SourceLineEnding; patchable: boolean } {
  if (!content.includes("\r")) return { eol: "lf", patchable: true };
  const crlf = content.match(/\r\n/g)?.length ?? 0;
  const lf = (content.match(/\n/g)?.length ?? 0) - crlf;
  return { eol: crlf > lf ? "crlf" : "lf", patchable: false };
}

/** MARKDOWN (CM6 source, "\n" breaks) spelled with the file's line ending. */
export function sourceWithLineEnding(markdown: string, eol: SourceLineEnding): string {
  return eol === "crlf" ? markdown.replace(/\r?\n/g, "\r\n") : markdown;
}
