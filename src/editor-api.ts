import type { EditorView, ViewUpdate } from "@codemirror/view";

import { createEditorCM6 } from "./cm6/editor-cm6.ts";
import type {
  EditorClipboardPayload,
  EditorPasteAssetStore,
  EditorPasteOptions,
} from "./paste.ts";

export { normalizePastedSourceText } from "./clipboard.ts";
export type {
  EditorClipboardPayload,
  EditorPasteAssetStore,
  EditorPasteOptions,
  EditorPastePlacement,
  StoredPasteAsset,
} from "./paste.ts";

export type EditorKernel = "cm6";

export interface EditorOptions {
  /** Initial markdown the editor opens with. Defaults to empty. */
  initialContent?: string;
  /** Fired on every document transaction; arg is the current markdown. Raw, no debounce. */
  onChange?: (md: string) => void;
  /** Fired when the markdown selection changes. Raw; consumers should keep it memory-only. */
  onSelectionChange?: (selection: { from: number; to: number }) => void;
  /** Fired when the editor surface gains focus. */
  onFocus?: () => void;
  /** Fired when the editor surface loses focus. */
  onBlur?: () => void;
  /** Retained for source compatibility; the only supported kernel is CM6. */
  kernel?: EditorKernel;
  /** Current note file for note-relative attachment storage. */
  getCurrentFile?: () => string;
  /** Optional attachment storage used by the editor paste pipeline. */
  pasteAssets?: EditorPasteAssetStore;
  /** Optional host fallback for xwidget/system clipboard reads. */
  readSystemClipboardFallback?: () => Promise<EditorClipboardPayload | null>;
  /** When non-nil, the editor renders and navigates normally but rejects edits. */
  readOnly?: boolean;
}

export type EditorCommand =
  | "bold"
  | "italic"
  | "highlight"
  | "strike"
  | "code"
  | "link"
  | "superscript"
  | "subscript"
  | "insert-footnote"
  | "insert-revision"
  | "edit-properties"
  | "move-block-up"
  | "move-block-down"
  | "blockquote"
  | "bullet-list"
  | "ordered-list"
  | "task-list"
  | "code-block"
  | "paragraph-menu"
  | "insert-table"
  | "insert-math-block"
  | "insert-toc"
  | "insert-org-env"
  | "jupyter-cell"
  | "image-edit"
  | "table-insert-row"
  | "table-insert-column"
  | "table-delete-row"
  | "table-delete-column"
  | "table-align-left"
  | "table-align-center"
  | "table-align-right"
  | "table-move-row-up"
  | "table-move-row-down"
  | "table-move-column-left"
  | "table-move-column-right"
  | "table-format"
  | "heading-1"
  | "heading-2"
  | "heading-3"
  | "heading-4"
  | "heading-5"
  | "heading-6"
  | "fold-heading"
  | "unfold-heading"
  | "toggle-fold"
  | "fold-all-headings"
  | "unfold-all-headings"
  | "copy-code";

export type WritingModeOptions = {
  focusMode?: boolean;
  typewriterMode?: boolean;
};

type Rect = { left: number; top: number; bottom: number };
type SelectionMode = "start" | "end" | "all";

export type EditorBlockContext = {
  type: string;
  from: number;
  to: number;
  contentFrom: number;
  contentTo: number;
  text: string;
  empty: boolean;
  depth: number;
  parentType: string | null;
  sourceMode: boolean;
  commands: EditorCommand[];
  rect: Rect | null;
};

export type QuickInsertItem = {
  id: string;
  label: string;
  detail?: string;
  keywords?: readonly string[];
  command?: EditorCommand;
  value?: string;
  markdown?: string;
  select?: SelectionMode;
};

export type QuickInsertContext = {
  query: string;
  block: EditorBlockContext;
  before: string;
  after: string;
  sourceMode: boolean;
};

export type QuickInsertProvider = (
  context: QuickInsertContext,
) => readonly QuickInsertItem[];

export function blockCommands(type: string): EditorCommand[] {
  if (type === "table_cell") {
    return [
      "table-insert-row",
      "table-insert-column",
      "table-delete-row",
      "table-delete-column",
      "table-align-left",
      "table-align-center",
      "table-align-right",
      "table-move-row-up",
      "table-move-row-down",
      "table-move-column-left",
      "table-move-column-right",
      "table-format",
    ];
  }
  if (type === "code_block") return ["copy-code", "code-block"];
  return [
    "move-block-up",
    "move-block-down",
    "heading-1",
    "heading-2",
    "heading-3",
    "blockquote",
    "bullet-list",
    "ordered-list",
    "task-list",
    "code-block",
    "insert-table",
    "insert-math-block",
    "insert-toc",
    "insert-org-env",
    "jupyter-cell",
  ];
}

export function quickMatches(item: QuickInsertItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    item.id,
    item.label,
    item.detail ?? "",
    item.command ?? "",
    item.value ?? "",
    ...(item.keywords ?? []),
  ].join(" ").toLowerCase();
  return haystack.includes(q);
}

const builtInQuickInsertItems: QuickInsertItem[] = [
  {
    id: "footnote",
    label: "Footnote",
    detail: "[^1]",
    command: "insert-footnote",
    keywords: ["reference", "note"],
  },
  {
    id: "revision",
    label: "Revision",
    detail: "@@revision",
    command: "insert-revision",
    keywords: ["review", "suggestion", "change"],
  },
  {
    id: "metadata",
    label: "Document properties",
    detail: "#+begin meta",
    command: "edit-properties",
    keywords: ["meta", "frontmatter", "property"],
  },
  {
    id: "heading-1",
    label: "Heading 1",
    detail: "#",
    command: "heading-1",
    keywords: ["title", "h1"],
  },
  {
    id: "heading-2",
    label: "Heading 2",
    detail: "##",
    command: "heading-2",
    keywords: ["section", "h2"],
  },
  {
    id: "heading-3",
    label: "Heading 3",
    detail: "###",
    command: "heading-3",
    keywords: ["subsection", "h3"],
  },
  {
    id: "bullet-list",
    label: "Bullet list",
    detail: "- item",
    command: "bullet-list",
    keywords: ["ul", "list"],
  },
  {
    id: "ordered-list",
    label: "Ordered list",
    detail: "1. item",
    command: "ordered-list",
    keywords: ["ol", "numbered"],
  },
  {
    id: "task-list",
    label: "Task list",
    detail: "- [ ] item",
    command: "task-list",
    keywords: ["todo", "checkbox"],
  },
  {
    id: "blockquote",
    label: "Blockquote",
    detail: "> quote",
    command: "blockquote",
    keywords: ["quote"],
  },
  {
    id: "code-block",
    label: "Code block",
    detail: "```",
    command: "code-block",
    keywords: ["fence", "source"],
  },
  {
    id: "jupyter-cell",
    label: "Jupyter cell",
    detail: "@@cell",
    command: "jupyter-cell",
    keywords: ["cell", "jupyter", "python", "kernel"],
  },
  {
    id: "copy-code",
    label: "Copy code",
    detail: "Clipboard",
    command: "copy-code",
    keywords: ["clipboard"],
  },
  {
    id: "table",
    label: "Table",
    detail: "2 x 2",
    command: "insert-table",
    keywords: ["gfm", "grid"],
  },
  {
    id: "table-insert-row",
    label: "Insert row",
    detail: "Below",
    command: "table-insert-row",
    keywords: ["table", "row"],
  },
  {
    id: "table-insert-column",
    label: "Insert column",
    detail: "Right",
    command: "table-insert-column",
    keywords: ["table", "column", "col"],
  },
  {
    id: "table-delete-row",
    label: "Delete row",
    detail: "Current",
    command: "table-delete-row",
    keywords: ["table", "row", "remove"],
  },
  {
    id: "table-delete-column",
    label: "Delete column",
    detail: "Current",
    command: "table-delete-column",
    keywords: ["table", "column", "col", "remove"],
  },
  {
    id: "table-align-left",
    label: "Align left",
    detail: "Column",
    command: "table-align-left",
    keywords: ["table", "align", "left"],
  },
  {
    id: "table-align-center",
    label: "Align center",
    detail: "Column",
    command: "table-align-center",
    keywords: ["table", "align", "center"],
  },
  {
    id: "table-align-right",
    label: "Align right",
    detail: "Column",
    command: "table-align-right",
    keywords: ["table", "align", "right"],
  },
  {
    id: "table-move-row-up",
    label: "Move row up",
    detail: "Swap",
    command: "table-move-row-up",
    keywords: ["table", "row", "move", "up"],
  },
  {
    id: "table-move-row-down",
    label: "Move row down",
    detail: "Swap",
    command: "table-move-row-down",
    keywords: ["table", "row", "move", "down"],
  },
  {
    id: "table-move-column-left",
    label: "Move column left",
    detail: "Swap",
    command: "table-move-column-left",
    keywords: ["table", "column", "col", "move", "left"],
  },
  {
    id: "table-move-column-right",
    label: "Move column right",
    detail: "Swap",
    command: "table-move-column-right",
    keywords: ["table", "column", "col", "move", "right"],
  },
  {
    id: "table-format",
    label: "Format table",
    detail: "Align columns",
    command: "table-format",
    keywords: ["table", "format", "align"],
  },
  {
    id: "math-block",
    label: "Math block",
    detail: "\\[ \\]",
    command: "insert-math-block",
    keywords: ["latex", "tex", "equation"],
  },
  {
    id: "toc",
    label: "Table of contents",
    detail: "[toc]",
    command: "insert-toc",
    keywords: ["outline"],
  },
  {
    id: "org-env-proof",
    label: "Proof block",
    detail: "#+begin proof",
    command: "insert-org-env",
    value: "proof",
    keywords: ["org", "env"],
  },
  {
    id: "org-env-theorem",
    label: "Theorem block",
    detail: "#+begin theorem",
    command: "insert-org-env",
    value: "theorem",
    keywords: ["org", "env"],
  },
  {
    id: "org-env-note",
    label: "Note block",
    detail: "#+begin note",
    command: "insert-org-env",
    value: "note",
    keywords: ["org", "env"],
  },
  {
    id: "image",
    label: "Image",
    detail: "![alt](src)",
    command: "image-edit",
    keywords: ["picture", "asset", "file"],
  },
];

export function builtInQuickInsertProvider(context: QuickInsertContext): QuickInsertItem[] {
  const allowed = new Set(context.block.commands);
  return builtInQuickInsertItems
    .filter((item) => {
      if (item.command) return allowed.has(item.command);
      return context.block.type !== "table_cell" && context.block.type !== "code_block";
    })
    .filter((item) => quickMatches(item, context.query));
}

export type SetMarkdownOptions = {
  /** How replacing the whole document should interact with the editor undo stack. */
  history?: "record" | "skip" | "reset";
};

export type SelectionOptions = {
  /** Whether selecting a range should ask the editor to scroll it into view. */
  scrollIntoView?: boolean;
};

export interface Editor {
  /** Current markdown source. */
  getMarkdown(): string;
  /** Current markdown source length without materializing the whole document. */
  getMarkdownLength(): number;
  /** Current markdown after yielding to async callers. */
  getMarkdownAsync(): Promise<string>;
  /** Render the current document to HTML for clipboard/export integrations. */
  getHTML(): string;
  /** Replace the document. */
  setMarkdown(md: string, options?: SetMarkdownOptions): void;
  /** Insert plain source text at the current selection, optionally replacing chars before point. */
  insertText(text: string, deleteBefore?: number): { from: number; to: number };
  /** Paste from the browser/system clipboard through the editor paste pipeline. */
  pasteFromClipboard(options?: EditorPasteOptions): Promise<boolean>;
  /** Paste a browser DataTransfer through the editor paste pipeline. */
  pasteFromDataTransfer(data: DataTransfer, options?: EditorPasteOptions): Promise<boolean>;
  /** Paste plain markdown source text through the editor paste pipeline. */
  pastePlainText(text: string, options?: EditorPasteOptions): boolean;
  /** Select a source range. */
  setSelection(from: number, to?: number, options?: SelectionOptions): void;
  /** Select a markdown-source range. */
  setMarkdownSelection(from: number, to?: number, options?: SelectionOptions): void;
  /** Current selection as markdown-source offsets. */
  getMarkdownSelection(): { from: number; to: number };
  /** Current selection as markdown-source offsets preserving direction (anchor/head). */
  getMarkdownSelectionRange(): { anchor: number; head: number };
  /** Replace a markdown-source range. */
  replaceMarkdownRange(from: number, to: number, text: string, select?: SelectionMode): { from: number; to: number };
  /** Current active-surface selection. */
  getSelection(): { from: number; to: number };
  /** Reveal the active cursor in the viewport. */
  revealCursor(): void;
  /** Plain active-surface text between offsets. */
  textBetween(from: number, to: number): string;
  /** Plain markdown-source text between offsets. */
  markdownBetween(from: number, to: number): string;
  /** Replace active-surface text between offsets. */
  replaceRange(from: number, to: number, text: string, select?: SelectionMode): { from: number; to: number };
  /** Undo the active surface if possible. */
  undo(): boolean;
  /** Redo the active surface if possible. */
  redo(): boolean;
  /** Run a built-in editing command against the active surface. */
  runCommand(command: EditorCommand, value?: string): boolean;
  /** Current block around the active cursor, for block menus and slash insert. */
  getBlockContext(): EditorBlockContext;
  /** Register app-specific slash/quick-insert items. Returns an unregister function. */
  registerQuickInsertProvider(provider: QuickInsertProvider): () => void;
  /** Resolve quick-insert candidates for the active cursor. */
  getQuickInsertItems(query?: string): QuickInsertItem[];
  /** Apply a quick-insert item returned by `getQuickInsertItems()`. */
  runQuickInsert(item: QuickInsertItem): boolean;
  /** Toggle writing affordances without changing markdown. */
  setWritingMode(options: WritingModeOptions): void;
  /** Text and viewport rect around the active cursor, for completions/previews. */
  cursorContext(maxChars?: number): {
    before: string;
    after: string;
    rect: Rect | null;
    rectAtOffset: (offset: number) => Rect | null;
  };
  /** Viewport rect for the active cursor without reading surrounding text. */
  cursorRect(): Rect | null;
  /** Flip between preview and raw-source CM6 modes. */
  toggleSource(): void;
  /** Whether the editor is currently in raw-source mode. */
  isSourceMode(): boolean;
  /** Focus the editor. */
  focus(): void;
  /** Tear down the editor and remove its DOM. */
  destroy(): void;
  /** Subscribe to CM6 transactions across whole-state document resets. */
  onViewUpdate(listener: (update: ViewUpdate) => void): () => void;
  /** Subscribe to whole-document state replacement (opening another note). */
  onDocumentReset(listener: () => void): () => void;
  /** Escape hatch: the live CM6 EditorView. Advanced; no API stability promised on this access. */
  readonly view: EditorView;
}

export function createEditor(
  host: HTMLElement,
  options: EditorOptions = {},
): Editor {
  return createEditorCM6(host, options);
}
