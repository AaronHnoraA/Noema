# Marker / MarkText / files.md editor study (round 2)

Reviewed 2026-10-02, all MIT-licensed:

- Marker <https://github.com/tk04/Marker> at `b878afcb2c8895702cacce2613f9081d3682ddc7`
  (Tauri + Tiptap/ProseMirror).
- MarkText <https://github.com/marktext/marktext> at `af3ace5510ae938f6dddc405003c2eab623f841f`
  (the Muya engine, `packages/muya/src`).
- files.md <https://github.com/zakirullin/files.md> at `9e948ba6071e320c41c866f92817cf96f9bb7ba6`
  (HyperMD on CodeMirror 5, `web/` and `web/lib/`).

Round 1 (commit `5959139`) adopted the editing semantics that fit a
source-authoritative CM6 editor: inline/block format toggles, fence closing,
CJK emphasis, context-aware paste, undo grouping, CRLF saves and find options.
This round audits what those files implement beyond that, per feature, and
compares functionality, interaction, page logic, performance and lifecycle.
Interaction ideas are ported; no source code is copied, and Markdown stays the
only document model.

## Adopted

| Area | Reference behaviour | Noema change |
|---|---|---|
| Lists | MarkText splits a list around the paragraph an empty item becomes | Enter on an empty item/quote line keeps a blank line wherever new text would touch a neighbour, so it no longer lazily continues the previous item; a nested empty item steps out one level |
| Inline formats | MarkText `tabHandler` jumps past a closing format | Tab at the end of a span's content moves past `**`, `` ` ``, `==`, `~~`, `\)` or a link's `](url)` |
| Tables | MarkText `TableCellContent` arrow/Enter/Backspace handlers | Arrows and Backspace at a cell's text edge move between cells and, past the table, back to the document (opening a line at the note's edge); Mod-Enter adds a row below; a selected cell moves with arrows |
| Tables | MarkText `TableRectSelection`, Marker's prosemirror-tables `DeleteCells` | Drag / Shift-click / Shift+Arrow rectangle selection; Mod-C copies a cell's text or a GFM sub-table; Delete empties cells, then removes spanned columns, rows or the table; Mod-X; Mod-A grows cell → table → document |
| Tables | GFM, export (markdown-it), Lezer | `|-|:-:|` delimiter rows and tables without outer pipes render in the editor; the body runs to a blank line, another block or a `{layout}` line, so plain text directly under a table is a row, as in export |
| Emoji | MarkText emoji picker, files.md `CompleteEmoji` | `:name:` renders in live preview from export's own table; `:na` completes to the character |
| Media | files.md `fold-image`, Marker `ImageView` | `![](clip.mp4)` / `![](talk.mp3)` become native players (no autoplay) in editor and export |
| Footnotes | MarkText footnote tool | Hovering a reference shows its definition or flags it as undefined |
| Quick insert | MarkText paragraph placeholder and diagram entries | "Type / for commands" on the focused empty line (not in code or Vim normal mode); Mermaid and mind-map entries |
| Blocks | MarkText paragraph front menu (Duplicate, Delete) | `duplicate-block` / `delete-block` commands and context-menu entries with Move Up/Down; copies of paragraphs, tables, fences and math are set apart by a blank line |
| Images | MarkText `Format.backspaceHandler` selects an inline image first | Backspace after (Delete before) an image selects it with its `{layout}` attributes; the next press removes it whole |
| Line breaks | HyperMD `newline` (Shift-Enter) | Shift-Enter continues a list item at its content indent or a quote with its `>`, never a new marker; the xwidget path maps WebKit's `insertLineBreak` to it |

## Already equivalent or better in Noema

Selection wrapping and bracket pairing, closing-fence on Enter, heading
Enter/Backspace, task continuation, table Tab/Enter navigation and edge
buttons, footnote jump-and-back, link hover previews, drag-select autoscroll
(CM6), Cmd-Backspace joining lines at column 0 (CM6), image toolbar and
resizing, block drag handles, language-picker for fences, word-sized undo.

## Deliberately excluded

- Markdown-syntax auto-pairing of `*`, `_`, `` ` `` and `$` while typing
  (MarkText `autoPairMarkdownSyntax`): it fights list markers and source edits.
- `$`/`$$` math (Noema uses `\(...\)`/`\[...\]`), `table` + Enter input rule
  (Marker), always-hidden internal link targets (files.md), paste into a
  multi-cell rectangle (MarkText cancels it too).
- Treating Enter in a paragraph as a new block: Noema keeps source line
  semantics.
- Rich (`text/html`) copy as MarkText writes it: in the Emacs host every copy
  is mirrored to the macOS pasteboard as plain text, so it needs a host
  transport for HTML first.

## Memory, lifecycle and responsiveness

Measured with the 5 MB fixture (`tests/synthetic_qc_note_5mb.md`) under
happy-dom, heap after forced GC:

- Opening the 5 MB note cost +85.5 MB; it now costs +53.2 MB. ~165k line
  decorations each carried their own attribute map (now one shared value per
  class / org-env kind and depth), and org-env block titles and bodies were
  substrings of a whole-note `toString()`, pinning a 9.9 MB copy of the note.
  1,200 keystrokes plateau after the 200-step history depth.
- 1,200 note switches (`setMarkdown`, typing, source toggles) over 40 notes:
  the editor's own objects stay flat; the remaining drift is happy-dom's style
  cache.
- `destroy()` releases the editor in browsers. In happy-dom CM6's module
  `scratchRange` keeps the last view, because happy-dom does not move live
  Ranges when nodes are removed (WebKit does).
- Fixed: a replaced Jupyter widget manager stayed reachable through a window
  `resize` listener; the Jupyter page's 1 s run clock ran while idle; per-cell
  run status and per-file kernel lists were unbounded across notes.
- An idle editor schedules no timers or animation frames.

Keystroke cost (median, 120 keys): 120 KB note 4.3 → 2.2 ms (the block-drag
gutter walked each visible heading's whole section on every edit; the TOC
signatures are now lazy). 5 MB note 17.8 → 16.6 ms near the start; near the
end about 50 ms, of which ~70% is Lezer re-balancing the flat top-level node
of a ~100k-block document.

In headless WebKit with real key presses, keydown to the second following
frame measures 34 ms median for a near-empty note (the two frame waits) and
42 ms for a 120 KB note (1 MB: 41 ms): typing adds about 8 ms of script,
layout and paint, inside one 16 ms frame.

## Verification

Unit tests run under happy-dom. `scripts/check-editor-interactions.mjs`
drives a real WebKit page for what an emulator cannot judge: emoji and media
render, the empty-line hint leaves the line box and caret unchanged, a mouse
drag selects a table rectangle and Delete empties it, arrows cross cells and
leave the table, Backspace selects a rendered embed whole, and Tab leaves
bold. It found that the table widget stopped `mouseup` before the drag's
document listener, so those listeners run in the capture phase.

`scripts/check-memory-soak.mjs` repeats the long-session test in Chromium with
GC forced through the DevTools protocol: 18.2 MB at start, 22.0–22.7 MB from
switch 100 to switch 600 over 40 notes, 24.2 → 23.7 MB across 20 editor
destroy/re-create cycles.

