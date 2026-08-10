# Noema

> License: AGPL-3.0-only. The source-editor infrastructure includes attributed
> adaptations from Overleaf; see [NOTICE](NOTICE) and
> [the architecture review](docs/architecture/overleaf-source-editor-study.md).

> A Typora-style Markdown editor for the web, Emacs, and macOS.

This README is package-focused. Emacs links the canonical project at
`lisp/roam/Noema`; the retired `lisp/roam/aaronnote` project link must not be
reintroduced. The Emacs entry point remains `lisp/roam/init-aaronnote.el` as a
wire/file compatibility contract.

Markdown looks like a finished document while you write it. Italic renders as *italic* the moment you close the asterisks. Headings appear at their final size as soon as you start typing. Source markers like `*` and `#` fade out when the cursor moves away and come back when you click in.

It's also an experiment. Every line of source was written by an AI agent through chat. The human only chats; nothing gets typed directly into source files. To keep the agent productive at this scale, each supported syntax is described as a **spec**: a seed text, an event sequence, and the expected rendered output. Each spec compiles to a test the agent has to make pass. The result is a usable editor and a record of how far agent coding holds up on a serious project.


## Try it

> If you're reading this on GitHub, the live editing effect won't show. Visit the [live demo](https://yuyz0112.github.io/typora-web/ "live demo") for the actual editor.

Inline marks: **bold**, *italic*, `inline code`, ~~strike~~, ==highlight==, sub like H~2~O, sup like E = mc^2^. Bare URLs in angle brackets become autolinks: <https://codemirror.net>. Regular links work the usual way: [CodeMirror guide](https://codemirror.net/docs/guide/ "CodeMirror Guide"), [CommonMark spec](https://spec.commonmark.org/ "CommonMark"). Emoji shortcodes resolve as you type: :books: :tada: :hourglass: :warning:.


Task lists hold their state visually:

- [x] inline marks (em, strong, code, strike, highlight, sub/sup)
- [x] autolinks and reference-style links
- [x] tables with per-column alignment
- [x] inline and block math
- [~] mermaid code-fence preview

Lists nest, and exit on a triple-Enter staircase the way Typora does:

1. outer ordered item

   - nested bullet with a `code span`
   - another, with **bold** in it

     1. third level
2. back to the outer list

> Blockquotes render inline marks just like paragraphs do. You can drop ==highlights==, [links](https://typora.io), or `code` into a quote and the source still round-trips byte for byte.
>
> Press Enter on an empty quote line to exit.

Press `⌘/` (or `Ctrl+/`) at any time to toggle between rendered and raw source view.


## Desktop app

```sh
nvm install
nvm use
make setup
make
make install
```

Node `26.5.0` and npm `11.17.0` are pinned by `.nvmrc`, `.node-version`,
`package.json`, and `.npmrc`; `make bootstrap` uses the committed lock file via
`npm ci`. `make`/`make build` creates `Noema.app` under `release/`, while
`make install` installs it into `/Applications`.

The desktop host is independent from Emacs, stores runtime state under the
app's user-data directory, and opens source-code targets in a new VS Code
window. Its note root defaults to `~/Documents/Noema` and is created
automatically. Another machine only needs the development environment above;
optional locations can be changed through:

```sh
export NOEMA_ROOT="$HOME/Documents/Noema"
export NOEMA_RESOURCES_ROOT="/path/to/Noema/resources"
export NOEMA_VSCODE="/path/to/code"
```

The default Legacy layout can be switched explicitly to a global
multi-repository Wiki from Noema Configuration. Wiki layout indexes only
direct Git repository children of `public/` and `private/`; it never migrates
or initializes existing directories automatically. Once enabled, edits are
saved to Markdown first and each affected repository is automatically
checkpointed locally on shutdown and batch-synchronized at startup and roughly
once per day. File and metadata mutations refresh `wiki.db` incrementally;
successful Git refreshes use their changed paths and occasionally run a full
self-healing rebuild. Conflicts remain isolated for explicit resolution. See
[the Wiki workspace guide](docs/wiki-workspace.md).

Noema.app has a native macOS application menu and a draggable system title
bar mirroring the Emacs editor header: back, forward, refresh, editor actions,
window actions, and the current filename. These are two maintained host
adapters—the App controls do not remove or replace the Emacs header-line.

Desktop drag/drop follows the note workflow:

- Drop one or more Markdown files to open each in a new Noema window.
- Hold Option while dropping Markdown to insert it through the attachment
  pipeline instead.
- Drop images, other files, links, or text to insert them at the drop cursor.

Desktop plugins are managed from **Noema → Settings… → Plugins** and apply
after restart. Noema ships the Simplified Chinese UI translation as its first
built-in, opt-in plugin. Personal plugin packages can be installed under the
Noema user-data `plugins/` directory; see [Desktop plugins](docs/plugins.md) for
the manifest, lifecycle API, and launch overrides.

GitHub Copilot is an always-active built-in plugin. Noema.app starts its
packaged language server lazily; Emacs-started Noema continues using Emacs's
existing `copilot.el` connection through the gateway and never launches a
second Copilot server.

## Server reader

Server mode publishes the existing CM6 renderer directly: Markdown stays the
source of truth and is not converted to a second HTML tree. The editor is
forced read-only, and authoring, configuration, Git, task, Jupyter, Copilot,
clipboard, and local-host APIs are denied by the server even if called outside
the UI. Search, Wiki navigation, graph, themes, and slides reuse the local
implementation. Server mode defaults to the Wiki's warm light `claude` palette;
`appearance.theme` can select any packaged theme.

`runtime.json.reader` controls reader-only interaction chrome without changing
Markdown parsing, CM6 rendering, or the App's content layout: `showSource`,
`showGraph`, `showSearch`, `showToc`, `showStatus`, `selectionToolbar`, `customContextMenu`, and
`editingAids` are booleans. Defaults hide Source, status, selection and
authoring controls while leaving the rendered document identical to the App;
the graph remains available.

Create the local, ignored configuration directory and edit both files:

```sh
make server-config-init
$EDITOR server-config/runtime.json
$EDITOR server-config/deploy.json
```

`runtime.json` declares each repository URL as `public` or `private`. Only
pages in public repositories without `private: true` are projected into the
browser index, search, graph, backlinks, reports, and asset routes. Private
repositories may still be mirrored so the internal index can resolve the full
workspace, but none of their paths or content are returned to clients. Public
URLs are stable repository-relative references such as
`/?file=public/math/tensor.md`.

At startup and every `pullIntervalMinutes` (360 / six hours by default), Server mode detects
the remote HEAD with a `main`, then `master`, fallback and makes each checkout
an exact remote mirror using fetch, reset, and clean. Local changes inside
`server-config/repos/` are therefore disposable. Git credentials belong in the
server's SSH agent or credential helper; embedded credentials in repository
URLs are rejected.

Run locally or deploy the versioned release over SSH/rsync:

```sh
make server-start
make server-build
make server-deploy
```

Deployment installs production dependencies, switches the remote `current`
symlink, links and restarts a systemd user service, verifies `/health`, and
rolls the symlink back if verification fails. After a successful health check,
it keeps `retainReleases` releases in total (3 by default, including the active
release) and removes older version directories. The remote account needs a
working systemd user manager (and lingering when it must run after logout).
TLS/reverse-proxy setup such as Nginx is intentionally outside Noema.

Noema owns the assets it consumes under `resources/`: Markdown and TeX
snippets, Noema/LaTeX templates, KaTeX macros, and the prose word list. The
Emacs configuration keeps its own `snippets/` and `templates/` roots, linking
only `snippets/{markdown-mode,tex-mode}` and
`templates/{noema,latex,tex}` into Noema. The complete
`etc/katex-macros` and `etc/prose-accepted-words.txt` assets remain links
because both hosts use them.

Existing `AARONNOTE_*` and `aaronnote:api:*` names remain wire compatibility
contracts.  Emacs commands and variables use only the `my/noema-*` namespace.

## App configuration and themes

Noema stores user settings in `~/.config/noema/config.json`. The current
schema keeps the selected packaged theme:

```json
{
  "schemaVersion": 1,
  "appearance": {
    "theme": "aaronnote"
  }
}
```

Open **Tools → Configuration** (or **Noema → Settings…** in the desktop app)
to manage these settings on the dedicated configuration page. Changes are
remembered globally and propagated to open Noema windows.

Themes are bundled with the application rather than copied into the config
directory. Theme metadata is registered in
`src/styles/themes/themes.json`, and the build discovers CSS files in that
directory automatically. Adding a packaged theme means adding its CSS file
and manifest entry; the config API and Tools picker do not need a new
hard-coded theme branch.

## Desktop builds

After `npm ci`, `npm run build:desktop` builds the native Tauri package for the
current platform: a macOS `.app`, a Windows NSIS installer, or a Linux
AppImage. Windows x64 and arm64 builds bundle the matching checksummed official
Node 26.5.0 sidecar and use the system WebView2 runtime; they do not bundle
Chromium.

On macOS, `make build` is the convenience entry point. Run `make install`
afterward to copy the already-built app into `/Applications`; installation
does not rebuild it.

## Library install

```sh
npm install typora-web
```

## Usage

```ts
import { createEditor } from "typora-web";
import "typora-web/widgets.css";
import "typora-web/theme-typora.css";

const editor = createEditor(document.querySelector("#app")!, {
  initialContent: "# hello",
  onChange: (md) => console.log(md),
});
```

Controller methods:


| Method / field | Description |
| --- | --- |
| `editor.getMarkdown()` | current markdown |
| `editor.setMarkdown(md)` | replace contents |
| `editor.toggleSource()` | flip rendered ↔ raw view (also bound to `⌘/` / `Ctrl+/`) |
| `editor.isSourceMode()` | boolean |
| `editor.focus()` | focus the active surface |
| `editor.destroy()` | tear down |
| `editor.view` | underlying CM6 `EditorView`. No stability guarantee on this access. |

Options: `initialContent`, `onChange(md)`, `onFocus()`, `onBlur()`.

Noema ships `typora-web/theme-typora.css` as its default theme. To roll your own, write a stylesheet that targets `.cm-editor` descendants.

## Emacs-embedded app

The vendored app is a focused single-document Markdown editor. Emacs owns note
selection, filesystem navigation, agenda, Git, Lean interaction, and graph
launching. The web editor keeps rendering, source mode, saving, native assets,
and built-in Copilot completion using Emacs's installed language-server binary.

Lean code fences remain static syntax-highlighted snippets. Interactive Lean
work stays in `lang/lean/`.

## Coverage

Legend: :white\_check\_mark: stable · :yellow\_circle: partial (note explains what's missing) · :pause\_button: todo.

### Block syntax

| Syntax | Status | Notes |
| --- | :---: | --- |
| paragraph | :white_check_mark: |  |
| ATX heading `#`..`######` | :white_check_mark: |  |
| setext heading (`===` / `---` underline) | :white_check_mark: |  |
| blockquote `>` | :white_check_mark: |  |
| bullet list `-` `*` `+` | :white_check_mark: |  |
| ordered list `1.` | :white_check_mark: |  |
| nested list | :white_check_mark: |  |
| task list `- [ ]` / `- [x]` | :white_check_mark: |  |
| fenced code ```` ``` ```` | :white_check_mark: |  |
| indented code (4-space) | :white_check_mark: | source shape is preserved byte-for-byte |
| thematic break `---` | :white_check_mark: |  |
| table `\\| a \\| b \\|` | :white_check_mark: |  |
| YAML front matter | :white_check_mark: |  |
| reference link def `[id]: url` | :white_check_mark: | definition line renders as dimmed `syntax-hint`; `[text][id]` click resolves via on-demand syntax scan |
| HTML block | :white_check_mark: | block widget; sanitized via `sanitizeEmbeddedHtml` (DOMPurify, forbids script/iframe/object) |
| math block `\[…\]` | :white_check_mark: | block node, source-preserving parse/serialize, rendered preview |

### Inline syntax

| Syntax | Status | Notes |
| --- | :---: | --- |
| em `*x*` / `_x_` | :white_check_mark: |  |
| strong `**x**` / `__x__` | :white_check_mark: |  |
| nested `***em+strong***` | :white_check_mark: | CommonMark rule-of-three cases covered |
| inline code `` `x` `` | :white_check_mark: |  |
| strike `~~x~~` | :white_check_mark: |  |
| link `[text](url)` | :white_check_mark: | nested brackets, escaped `\]`, and angle-bracket hrefs with spaces covered |
| link with title `[t](u "title")` | :white_check_mark: |  |
| empty-text link `[](url)` | :white_check_mark: |  |
| image `![alt](src)` | :white_check_mark: |  |
| autolink `<https://x.com>` | :white_check_mark: |  |
| reference-style link `[t][id]` | :white_check_mark: | click resolves via on-demand LinkReference scan; def block preserved in source |
| hard break (2-space + `\n`) | :white_check_mark: |  |
| soft break (`\n` in para) | :white_check_mark: |  |
| backslash escape `\*` | :white_check_mark: | delimiter hides outside the cursor span and dims while editing |
| inline HTML | :white_check_mark: | inline widget; sanitized via `sanitizeEmbeddedHtml` |
| inline math `\(x\)` | :white_check_mark: | raw TeX preserved; rendered inline preview |

### Typora extensions

| Syntax                            | Status             | Notes                                     |
| --------------------------------- | :----------------: | ----------------------------------------- |
| highlight `==x==`                 | :white_check_mark: |                                           |
| subscript `~x~`                   | :white_check_mark: |                                           |
| superscript `^x^`                 | :white_check_mark: |                                           |
| footnotes `[^id]` / `[^id]: text` | :white_check_mark: | auto-number command, reference/definition navigation and HTML backrefs |
| `[toc]` block                     | :white_check_mark: |                                           |
| emoji `:smile:`                   | :white_check_mark: |                                           |
| HTML comment `<!-- -->`           | :white_check_mark: |                                           |
| inline command `@@cmd(x) [y]{k: v}` | :white_check_mark: | TODO/comment/side-comment plus native `@@revision(style) [original] {advice: "..."; reason: "..."}` with accept/keep/edit and visible HTML/LaTeX export |
| org command block `#+begin kind`   | :white_check_mark: | rendered through the org-env CM6 widget   |
| callout block `> [!note]`          | :white_check_mark: | editor shows left-border colour + title bold; HTML export wraps in `.callout` + `.callout-title` |
| heading fold `zc` / `zo` / `za`   | :white_check_mark: | foldService + chevron (hover-only); state lives in CM6 foldState |
| diagram fences (mermaid, flow, …) | :yellow_circle:    | `mermaid` preview exists for fenced code blocks; broader diagram families are not implemented |

### Editor behaviors

| Behavior                             | Status             | Notes |
| ------------------------------------ | :----------------: | ----- |
| cursor-aware delimiter hinting       | :white_check_mark: | |
| auto-pair brackets                   | :white_check_mark: | VSCode-style pairing, overtyping, selection wrapping, and paired deletion |
| math snippets and field navigation   | :white_check_mark: | Shared YAS catalog, local math completion, and bounded Cmd+[ / ]; see [usage](docs/snippets-and-jumps.md) and [catalog maintenance](docs/emacs-snippet-migration.md) |
| core reconnect                       | :white_check_mark: | Focus, click, typing, or input reconnects a broken event stream; an active retained xwidget can restart core on the same port. No idle retry loop or page refresh. |
| ordered-list auto-renumber           | :white_check_mark: | move/paste/delete renumbers in same transaction (single undo); `.`/`)` marker preserved |
| heading fold (`zc`/`zo`/`za`/`zM`/`zR`) | :white_check_mark: | foldService + hover-only chevron; state in CM6 foldState |
| lossless `parse → serialize → parse` | :white_check_mark: | |

## Current Notes

- Math is no longer a planned feature. The repo already contains parser, serializer, render, and editor tests for inline and display math.
- Mermaid is partially implemented through fenced-code preview and lazy rendering. The README used to describe it as future work; that is no longer accurate.
- Complex inline links use a custom Lezer `LinkEnd` parser so nested brackets remain part of the enclosing link text. Reference-definition reload renders the definition block as `syntax-hint`; click-to-jump resolves it via an on-demand scan.

## Spec

Specs are the project's core design choice and the harness the agent works in. Each Typora behavior is captured as a **spec**: a seed text, a sequence of input events, and the rendered output expected at each checkpoint. Every spec runs directly as a test case; the agent ships a behavior by making the test pass. Describing behaviors this way is what makes a project this size tractable for an agent to build.

The catalog lives at the [`/specs`](https://yuyz0112.github.io/typora-web/#/specs "spec catalog") page in the live demo, where each card is a spec you can step through.

## Contributing

Bug reports and feature requests are accepted as specs. If a Typora behavior isn't matched, file an issue with:

- a **seed** (the markdown the editor starts from; can be empty)
- an **event sequence** (the keys you press; the same DSL existing specs use)
- the **rendered output** Typora produces

The "report" link on every card in the [live demo's catalog](https://yuyz0112.github.io/typora-web/#/specs "spec catalog") prefills an issue with seed, events, and observed output ready for you to fill in.
