# Adjustable Media layout study

Source: [Yi-luo-hua/obsidian-adjustable-media](https://github.com/Yi-luo-hua/obsidian-adjustable-media), commit `d5c8785c37c39f9e3636ab1b50d7a251a0a3cd65`, MIT license. Pure geometry and source-model modules are copied under `vendor/adjustable-media-pure/`; Noema currently executes the geometry module. The upstream `<!-- vml ... -->` format is retained there for reference but is not a Noema authoring syntax.

## Noema layout contract

The persistent layout model is the existing `shared/layout-attrs.mjs` model: `align`, `wrap`, `width`, and `height`. Images store trailing `{...}` attributes; tables and diagrams store a following attribute line; TikZ stores attributes on its `#+begin tikz` line. The existing legacy colon/comma spelling still parses. Layout commands change only these source spans and preserve unrelated attributes and figure bodies.

`src/cm6/figure-layout-menu.ts` is the editor transaction layer for every visual figure. It identifies image, table, Mermaid and TikZ widgets, validates their immutable document snapshot, plans source edits, rejects overlapping or stale edits, and commits one undoable transaction. Each block figure exposes the same align, wrap, width and adjacent pairing controls; the width handle uses the same source writer. Pairing two different figures writes existing wrap and width attributes to both in one transaction. The next figure must be adjacent in source; prose between them is never rearranged.

`src/cm6/image-row-layout.ts` specializes this contract for adjacent native Markdown images on one line. It uses the upstream drop target and proportional resize geometry, with row reorder, split widths and shared row height. Joining adjacent image lines retains their original embed text. Double click opens the viewer in `image-viewer.ts`. Reader HTML recognizes the same native image row and width attributes. No Markdown conversion or extra metadata is needed.

Mixed image, table, TikZ and diagram figures now have a shared height handle and an explicit whole-figure grip. Alt+Up/Down or dragging the grip swaps two adjacent figures, including their complete source bodies and attribute lines. The swap preserves whitespace between figures and refuses intervening prose or stale source. This is intentionally a figure-level transaction, separate from the editor's existing generic block gutter.

For layouts that need a boundary around several Markdown blocks, `#+begin layout {cols=3 mode=grid}` / `#+end layout` uses Noema's existing Org environment scanner and attribute parser. The body remains ordinary Markdown. Grid mode places top-level blocks into two to four columns and multiple rows; flow mode lets prose flow between columns. The reader and CM6 preview share this rendering. The editor's group toolbar changes column count or mode, estimates an automatic column count, balances text column widths and reveals source for direct edits. Grid cells can be reordered with a grip or Alt+arrows; column dividers change width weights. Cell source spans come from the same Markdown parser invocation that renders them, without another scan. This is the only added authoring form; the upstream `vml` comments are not interpreted.

```markdown
#+begin layout {cols=2 mode=grid widths=55-45}
The explanation remains editable Markdown.

![Graph](graph.png){width=100%}

| Case | Value |
|---|---:|
| A | 1 |
#+end layout
```

`src/text-layout-measure.ts` is the reusable Pretext-backed measurement service exported from the library. It loads the package on first measurement, caches prepared text/font pairs with a 64-entry bound, refuses oversized input, measures fixed-width text, and estimates a text flow with a different width on each line. The layout group's Auto and Balance actions use it to choose column count and text column widths without trying multiple DOM layouts. Browser CSS and the existing CM6/Knuth-Plass line breakers still determine final line breaks; Pretext does not enter the per-keystroke or idle path.

## Performance and limits

- Image row recognition reads one visible line through Lezer and caches successful rows by immutable CodeMirror `Text`. It does not scan a document on every keystroke.
- Figure attribute planning reads each selected figure's source span. Adjacent pairing looks through mounted widgets only when the user invokes it.
- Pointer movement changes CSS previews at most once per animation frame; source changes happen on release. The writer refuses edits after the document changes during a gesture.
- Existing non-image blocks keep their own source representation. Pairing uses floats, so very narrow viewports may stack the two figures according to CSS. The image row supplies tighter proportional controls because native adjacent image embeds already form a single Markdown paragraph; mixed figure blocks cannot share that paragraph without introducing another syntax.
- The upstream video and caption directives are not mapped to new syntax: existing video embeddings and captions keep their current renderers. The layout group covers mixed media blocks, but cross-document block drops are outside this local source transaction model.

## Verification

Focused CM6 tests cover native image rows, reorder, resize, row height, lightbox, stale source, mixed figure transactions, shared controls, TikZ/table/Mermaid width and height handles, pairing, whole-figure swaps and layout groups. `tests/render-html.test.ts` and `tests/cm6/layout-group.test.ts` cover reader output. `tests/text-layout-measure.test.ts` guards preparation reuse and input bounds. The full project gates are `make test`, `make build`, and `make install`.
