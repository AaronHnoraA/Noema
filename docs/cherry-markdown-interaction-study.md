# Cherry Markdown interaction study

Reviewed upstream: <https://github.com/Tencent/cherry-markdown>, commit
`faa668e88c8209535d4f06c2cbe7392c19c2d6f7` (Apache-2.0).

This upgrade ports interaction ideas, not Cherry source code or proprietary
syntax. Noema remains CM6/source-authoritative and keeps standard Markdown
round trips.

Implemented gap set:

- standard `[^id]` footnote references and `[^id]: definition` blocks in live
  preview, HTML export, and published notes;
- table grid resizing (bounded to 8×8), edge add buttons, hover highlighting,
  and row/column drag reordering;
- image drag resizing that previews at animation-frame cadence and commits one
  trailing layout-attribute transaction on pointer release;
- fenced-code language editing, existing copy support, and session-local folding.

Deliberately excluded:

- table-to-ECharts and every chart subsystem;
- Cherry-only Markdown syntax;
- `$` and `$$` math delimiters (Noema continues to use `\(...\)` and
  `\[...\]`);
- document-wide rescans on mouse move or every keystroke.

Performance limits:

- footnote decorations scan visible ranges only and stop after 2,000 matches;
- a definition index is built only on reference click, cached by immutable CM6
  document identity, and capped at 50,000 scanned lines / 4,096 definitions;
- table size-picker DOM is created only when opened and contains at most 56
  cells; drag handles are bounded to 500 rows and 64 columns;
- drag reordering commits once on drop; image resizing commits once on release;
- code folds are session-local, capped at 128, discard stale ranges after edits,
  and rebuild decorations proportional to the active folded set.
