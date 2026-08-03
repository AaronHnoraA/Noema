# Noema

A Typora-style Markdown editor built on CodeMirror 6.

## State Model

Markdown source is the runtime document. The live editor authority is the CM6
`EditorState`: document text, selection, compartments, extensions, history, and
decorations. Rendered preview behavior is implemented with Lezer Markdown syntax
trees plus CM6 decorations/widgets; it must not depend on a parallel document
model.

Source mode and preview mode are both CM6 surfaces. `editor.toggleSource()`
switches the live-preview compartments on and off instead of swapping to a
separate editor implementation.

## Core Files

| File | Responsibility |
|---|---|
| `src/lib.ts` | Public library API. |
| `src/editor-api.ts` | Stable `createEditor()` facade and controller types. |
| `src/cm6/editor-cm6.ts` | CM6 shell and public editor methods. Feature order lives in `src/cm6/extensions/index.ts`. `getMarkdown()` is memoized by immutable-`Text` identity; prefer `getMarkdownLength()` when only length is needed. |
| `src/cm6/live-preview.ts` | Inline Markdown preview decorations and line classes. |
| `src/cm6/close-brackets-vscode.ts` | VSCode-style bracket pairing, selection wrapping, overtyping, and paired deletion. |
| `src/cm6/languages/markdown/` | Lezer Markdown boundary, including nested-bracket link parsing. |
| `src/cm6/commands/index.ts` | Editing commands, block context, and quick insert registry. |
| `src/cm6/extensions/visual/widgets/*.ts` | Math, code fence, image, task, TOC, org-env, and related widgets. `block-extras.ts` hosts the `@@cell` Jupyter widget; it renders cell output through the shared JupyterLab stack (lazy-loaded). |
| `src/jupyter-rendermime.ts` | Shared JupyterLab render stack for cell output — the same `@jupyterlab/rendermime` + `@jupyterlab/outputarea` pipeline VS Code Jupyter uses. Adds a KaTeX LaTeX typesetter, an HTML renderer that sandboxes script-bearing HTML in an auto-sizing iframe (and routes math-only HTML to KaTeX), and a widget-view renderer bridging to the live kernel manager. Loaded lazily (large). |
| `src/jupyter-widget-runtime.ts` | ipywidgets frontend: a `KernelWidgetManager` subclass over the live kernel (via `server/lib/jupyter-kernel-ws.mjs`). Mounts kernel-state-first (`restoreWidgets`), replays captured comm messages only as a fallback, and seeds Output widgets with server-captured outputs. Shares the render stack above. Lazy chunk. |
| `server/jupyter/` | Raw-ZMQ Jupyter kernel stack — logic ported from `microsoft/vscode-jupyter` (MIT) to plain `.mjs`, no build step. `wire-protocol.mjs`/`raw-socket.mjs`/`raw-kernel.mjs` are the ZMQ transport + the kernel_info/first-iopub warmup handshake; `kernel-process.mjs`/`kernel-ports.mjs`/`kernel-env.mjs`/`kernel-finder.mjs` launch and discover kernels; `kernel-registry.mjs` owns per-kernel lifecycle (launch/attach/restart/interrupt/self-heal, `widgetGeneration` bumping, orphan-process sweep); `execution-message-handler.mjs` drives one `execute_request` into aaronnote's output/widget-message shape. No Jupyter server process is spawned. |
| `server/lib/jupyter-cell.mjs` | Node cell service: hidden-script/output-mirror persistence, execution queueing, and orchestration over `server/jupyter/kernel-registry.mjs`. |
| `server/lib/jupyter-kernel-ws.mjs` | Browser-facing kernel channels WebSocket — bridges each browser connection to its own raw ZMQ socket set against the live kernel's connection info (no Jupyter server involved). Serves `/jupyter/nbextensions/*` from disk. |
| `server/lib/jupyter-output-router.mjs` | Server-side ipywidgets Output-widget output routing (ports VS Code Jupyter's `msgIdsToSwallow`): keeps display output produced inside an Output widget's context out of the top-level cell output and groups it by comm id for the client to seed. Used by `server/jupyter/execution-message-handler.mjs`. |
| `src/render-html.ts` | Shared Markdown-to-HTML export/publish renderer. |
| `src/math-render.ts` | KaTeX render + HTML cache. Cache key includes the active macro-set version. |
| `src/katex-macros.ts` | Global KaTeX macro state (`setKatexMacros`/`getKatexMacros`/`getKatexMacrosVersion`); re-exports the parser. |
| `shared/katex-macros.mjs` | Browser-safe `\newcommand`/`\DeclareMathOperator`/`\def` → KaTeX macros parser. |
| `server/lib/katex-macros.mjs` | Node loader: reads `*.tex` from a folder and parses via the shared parser. |
| `src/attrs-syntax.ts` | Shared `{key: value}` trailing-attribute block parser used by command-syntax and image-attrs. |
| `src/layout-attrs.ts` | Layout-attribute normalization (align, wrap, width, height) and CSS-class/style helpers. |
| `src/image-attrs.ts` | Image-specific layout attr reader/writer and DOM/token applicators, built on `layout-attrs.ts`. `imageLayoutToTrailingAttrs` serializes a layout back to `{...}` source (round-trips through `imageLayoutFromAttrs`); used by the image widget's hover toolbar. |
| `shared/command-syntax.mjs` | Canonical browser/server parser for inline `@@cmd` and block `#+begin kind` commands; `src/command-syntax.ts` is its typed facade. |
| `shared/planning-dsl.mjs` | Structural parser for the `@@todo`/`@@itodo`/`@@project`/`@@milestone`/`@@clock` planning DSL — inline/block shapes, bracket-less titles, parse-time diagnostics, patch/serialize helpers. See `docs/agenda.md`. |
| `shared/planning-values.mjs` | Value-grammar layer for the planning DSL: dates, repeaters, lead-time, dep-refs, durations, canonical-key aliasing, status normalization. Shared by the server and `src/planning-values.ts` (browser facade) so both validate identically. |
| `src/styles/*.css` | CM6 editor chrome and swappable Markdown themes. |
| `aaronnote/main.ts` | Shared editor composition shell used by both Emacs and Noema.app. |
| `aaronnote/tauri-bridge.ts` | Tauri renderer adapter exposing the compatibility `window.noemaDesktop` surface without Node or Electron globals. |
| `src-tauri/src/lib.rs` | Native Tauri desktop host: system WebView windows and menus, local Node sidecar lifecycle, dialogs, clipboard, drag/drop, sessions, and desktop commands. |
| `aaronnote/agenda.html`/`aaronnote/agenda-main.ts` | Vite entry for the standalone `/agenda` page — mounts `agenda-view.ts` in page mode using the same `api-client.ts` facade the embedded editor uses (`window.aaronnoteApi` is bridged in via `web-host.mjs`'s `adapterScript` for this page too). |
| `aaronnote/agenda-view.ts` | Full-screen, vault-wide agenda renderer: week/list/month/log/gantt/projects/clocktable/lints views over `api.notes.agenda`. All edits round-trip through `patchTodo`/`clockIn`/`clockOut` — holds no state that isn't re-derivable from markdown. See `docs/agenda.md`. |
| `aaronnote/latex-export-scope.ts` | Pure whole-note/selection/heading-subtree range model used by the LaTeX scope picker. |
| `server/lib/runtime.mjs` | Compatibility facade plus remaining note/index/save/agenda/Copilot implementation. New channel controllers live in `server/Features/`; transport helpers live in `server/infrastructure/`. See `docs/architecture/current-architecture.md`. |
| `server/lib/latex-export-pandoc.mjs` | Noema-aware preprocessing, fixed Pandoc Markdown profile, typed LaTeX marks, and academic LaTeX postprocessing. Pandoc is required in this fixed environment. |
| `server/lib/latex-export.mjs` | Template rendering, escaping, shared macro package generation, legacy pure helpers, and atomic `.tex` writes. |
| `server/lib/latex-export-codex.mjs` | Agent polish of the Pandoc draft: repository skills, mandatory review candidates, strict fidelity gate, compile-verify retry loop, and agent-maintained rules. |
| `agents/latex-export/` | Codex export contract (`AGENTS.md`), the agent-maintained `mechanical/rules.json` (envMap/commentBlocks merged into the base converter), and `notes.md`. Edited only on a maintenance pass, never during a normal export. |
| `server/lib/watch.mjs` | Recursive fs watcher for vault freshness; SSE broadcast on batch change. |
| `server/lib/tmp.mjs` | Runtime temp staging (`mkdtemp`, atomic writes, TTL orphan sweep). |
| `server/lib/copilot.mjs` | Re-export barrel for Copilot LSP bridge (uses Emacs-managed binary). |
| `web-host.mjs` | Node HTTP/SSE and static-serving composition root; Feature API handlers register through `server/infrastructure/api-router.mjs`. |
| `src/cm6/heading-fold.ts` | Heading fold service + hover-only chevron widget; reuses `tocIndexField`. |
| `src/cm6/ordered-list-renumber.ts` | Auto-renumber ordered lists; bounded `ensureSyntaxTree`; single-undo transaction. |
| `src/cm6/toc-index.ts` | Incremental TOC / heading index state field; used by outline and fold. |
| `src/copilot/index.ts` | Built-in Copilot inline UI and key handling for the main editor. |

## Emacs handoff

This editor is embedded in Emacs via xwidget/Appine. Panels and subsystems that
were part of the original desktop app are now delegated to native
Emacs equivalents:

| Removed subsystem | Emacs equivalent |
|---|---|
| Git panel (commit/diff/pull/push) | `magit` |
| Agenda / todos panel | Server-backed Noema agenda view-model, rendered by the standalone `/agenda` page (`aaronnote/agenda.html`/`agenda-main.ts`, mounting `aaronnote/agenda-view.ts`: week/list/month/log/gantt/projects/clocktable/lints) and opened via Emacs `my/noema-roam-agenda` |
| Filesystem browser ranger | `dired`, roam selector |
| Lean interactive editor (placeholders, infoview, child editors) | `lang/lean/` (Emacs LSP) |
| Jupyter panel | Noema `@@cell` |
| In-editor roam graph | `my/noema-roam-graph` → `/graph` standalone route |
| Plugin runtime + roamlookup | removed; Copilot is a built-in |

Fenced `lean` and `lean4` code blocks render as **static syntax-highlighted
snippets** in the web editor (no LSP process started from the browser).

## Widget Rules

All CM6 widgets that contribute vertical height must extend `MeasuredWidget`
(`src/cm6/extensions/visual/widgets/measured-widget.ts`) instead of bare `WidgetType`.
Call `this.registerMeasured(dom, view)` at every `toDOM()` return point.

```typescript
class MyWidget extends MeasuredWidget {
  protected measureKey() { return "my:" + this.stableId; }
  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement("div");
    // … build DOM …
    return this.registerMeasured(el, view);
  }
}
```

- No vertical `margin` on the widget root — CM6 measures border-box only; root
  vertical margins are invisible to the height map and cause cursor drift.
  Use root `padding` or child layout for vertical spacing instead.
- Override `measureGroupKey()` and `estimatedHeightFallback()` when scroll
  estimates matter; a fallback near the eventual height beats CM6's 1-line default.
- For widgets that support `layout.wrap` (CSS float): see the "Float-wrap
  coexistence" section in `docs/maintenance.md` — Pattern A for inline-replace
  widgets, Pattern B for `block:true` widgets.

## KaTeX macros

Custom KaTeX macros are defined as `.tex` files (LaTeX `\newcommand` syntax) in
`etc/katex-macros/` in the Emacs config and apply **globally** to every note.
Flow: the Node server reads the folder (env `AARONNOTE_KATEX_MACROS_DIR`, wired in
`lisp/roam/init-aaronnote.el`) via `server/lib/katex-macros.mjs`; the browser
fetches them through `api.config.katexMacros()` (channel
`aaronnote:api:config:katex-macros`) and installs them with `setKatexMacros`
before the first note renders; `scripts/render-html.mjs` does the same for
export/publish. `renderMathHTML` reads the active map on every call and folds the
macro-set version into its cache key. See `etc/katex-macros/README.md`.

## Invariants

1. Markdown source offsets are the stable cross-system coordinate space.
2. Public API methods should mutate the CM6 document with transactions whenever
   possible, preserving selection and history.
3. Preview widgets are views over source text. They must map clicks/commands back
   to source ranges rather than storing independent state.
4. Shared behavior belongs in `src/`; app shell code under `aaronnote/` should use
   the public editor facade instead of reaching into widget internals.
5. Styles should target `.cm-editor` and CM6/widget classes. Do not add legacy
   editor compatibility selectors.
6. Widget height re-measurement on window resize is handled by `MeasuredWidget`'s
   `ResizeObserver`; widgets must not add their own `window.resize` listeners.

## Testing

Use focused tests first:

```sh
npm test -- tests/editor-api.test.ts tests/cm6/roundtrip.test.ts tests/cm6/commands.test.ts
```

For broader changes, run the full suite from `Noema/`:

```sh
npm test
```
