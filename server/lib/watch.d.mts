export interface NoteWatcherHandle {
  close(): void;
}

export interface NoteWatcherBackend {
  on(event: "error", listener: (error: Error) => void): unknown;
  close(): void;
}

export interface StartNoteWatcherOptions {
  root: string;
  debounceMs?: number;
  isRelevant(relativePath: string): boolean;
  isDirectoryRelevant?(relativePath: string): boolean;
  isSelfWrite(absolutePath: string): boolean;
  onBatch(files: string[]): void;
  onFullRescan(): void;
  watchImplementation?(
    root: string,
    options: { recursive: boolean; persistent: boolean },
    listener: (eventType: string, filename: string | null) => void,
  ): NoteWatcherBackend;
}

export function startNoteWatcher(options: StartNoteWatcherOptions): NoteWatcherHandle;
