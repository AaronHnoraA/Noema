---
name: rendered-construct
description: Use before adding or changing anything the Noema visual editor draws over Markdown source — a CM6 widget, a Decoration.replace, a block environment, an inline chip, an embedded editor (table cell, MathLive), or a Vim motion that crosses rendered content. Covers choosing the role and reveal policy, the inlineConstruct factory, registering a block family, embedded surfaces, and the architecture guard tests.
---

# Adding or changing a rendered construct

The rules live in `../../docs/noema/design/rendered-constructs.md`. Read it first; this is the working checklist.

## Decide

1. **Role.** `object` — something the reader sees (formula, image, chip, diagram); Vim moves over it as one character, it stays rendered in Normal/Visual, and Backspace/Delete beside it selects it whole first (`objectAtEdge` in the registry) — so the role is all a new object needs for deletion too. `structure` — text and syntax the author edits (table, `@@` command, block heading, rule); it opens wherever the caret lands, in every mode, and Vim moves through it as text.
2. **Reveal policy** from `src/cm6/extensions/visual/constructs/reveal.ts`: `edge`, `interior`, `caret-edge`, `caret-interior`, `never`. If none fits, extend `reveal.ts` and the policy table in the doc — never write the comparison inside the widget.

## Build

- **Inline family** (matched from one line): `inlineConstruct({ kind, reveal, role, maxPerViewport, match })` in the widget module; add it to `createVisualMarkdownExtensions()` in `src/cm6/extensions/visual/index.ts`. The factory handles literal code/math, pinning, typing bursts, drags, caching and registry entry.
- **A viewport family** (a ViewPlugin) is a `constructViewPlugin({ build, revealKey, extra, mapDuringTyping, invalidates, beforeUpdate, setup, provide })`: the shared lifecycle decides when to rebuild (composition, typing bursts, pointer drags, refreshes, reveal keys, the persistent cache). Do not call `isCoalescedVisualTyping` or the persistent-cache helpers yourself.
- **A family whose drawing already applies the reveal rule** (a viewport plugin, a block field): register it with `constructSources.of(drawnConstructSource(kind, role, (state, view) => decorations))` — the registry then reads exactly what is drawn.
- **Block or stateful family**: keep its own incremental `StateField`; decide every reveal with `selectionOpensSource(state, from, to, policy, role)` from one helper shared by the builder and the rebuild key; react to `transactionChangesPinning(tr)` if it is an object; register with `constructSources.of({ kind, at })` (add `revealed` when an editing session, not the selection, opens it).
- A block family patches its decorations through `constructs/decoration-patch.ts`: record what the selection opened with `openedKey`, redraw with `rebuildForRevealChange` / `rebuildDecorations`; supply only the build function. No hand-written `filter: () => false`.
- Vertical motion: never call CodeMirror's `moveVertically`; rows come from `src/cm6/screen-rows.ts`, and a block that stays drawn is one row.
- Widgets that add height extend `MeasuredWidget` (`CLAUDE.md`, Widget Rules).
- Markdown shown inside a widget renders through `src/render-html.ts`: `renderMarkdownHTML` for blocks, `renderInlineMarkdownHTML` for inline content. No other Markdown library, no private `<p>`-unwrapping wrapper.
- Never remove an interaction the user relies on to make a family fit the model: tables keep click-to-edit-in-place (cell input, MathLive in cells, completion) while the keyboard opens their Markdown source. An element with its own editor (table cell input, MathLive) calls `markEmbeddedSurface(el)`; detect such elements with `EMBEDDED_SURFACE_SELECTOR` / `isInEmbeddedSurface`.

- A control in the widget (checkbox, field, menu, Accept button) writes with `dispatchConstructEdit(view, spec, kind?)` from the constructs layer, never `view.dispatch({ changes })`: one undo step per action, labelled `construct`.

## Never

- `sel.empty && sel.from ...` or any hand-written selection-versus-range test in a rendering module.
- Reading `dataset.vimMode` (use `renderedConstructsPinned(state)`), or setting it outside `publishMode` in `pages/vim-lite.ts`.
- Teaching Vim about a widget through decoration flags or a Markdown rescan — register a `ConstructSource`.
- A family-specific Backspace/Delete rule for an object (the old image-only `selectImageBeforeDelete`): give the construct the `object` role instead.
- Spelling `data-noema-vim` anywhere but `src/cm6/embedded-surface.ts`.

## Viewport

- A click on the construct must not move the view (unless it navigates). Focus anything inside the widget with `{ preventScroll: true }`; reveal with a transaction's `scrollIntoView`, never `element.scrollIntoView` or `scrollTop` (../../docs/noema/design/scroll-ownership.md, enforced by tests/architecture-scroll.test.ts).
- Add a sample of the construct to the fixture in `scripts/check-scroll-invariance.mjs` with its click intent (`opens`, `edits`, `navigates`) and run `npm run check:scroll` (WebKit), in full-app mode when the click involves host focus.

## Verify

```sh
npx tsc --noEmit -p .
npx vp test --run tests/architecture-constructs.test.ts tests/rendered-constructs.test.ts tests/vim-row-geometry.test.ts
npm test
```

The caret must never rest strictly inside a construct that is still drawn — it opens, or the caret lands on its edge; the "caret is never hidden" sweeps in the guard check it for every family in the sample note. There is no allowlist: every widget drawn over source must be in the registry. Add a sample of the new construct to the conformance note in `tests/architecture-constructs.test.ts` and its `kind` to the list it checks, so the registry and the drawing are proven to agree. If a guard fails, fix the code; if the rule itself must change, change `../../docs/noema/design/rendered-constructs.md` first, then the guard.
