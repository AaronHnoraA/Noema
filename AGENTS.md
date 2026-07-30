# Noema maintenance

Noema is a standalone application. The canonical source tree is this
repository; Emacs integrates through compatibility links and must never become
a runtime dependency of the desktop app.


## Environment

- Node is exactly `26.5.0`; npm is exactly `11.17.0`.
- Use `nvm install && nvm use`, then `make setup`.
- Use `npm ci`, not an unlocked dependency install, for reproducible setup.
- The default note root is `~/Documents/Noema`. `NOEMA_ROOT` may override it.
- The desktop app must create a missing note root before starting the host.

## Shared assets

`resources/` is the source of truth for assets consumed by Noema:

- `snippets/markdown-mode/` and `snippets/tex-mode/`
- `templates/noema/`, `templates/latex/`, and `templates/tex/`
- `katex-macros/` and `prose-accepted-words.txt`

Emacs links only those shared subdirectories from its historical asset roots;
Emacs-only snippet and template directories stay in the Emacs repository.
Emacs uses the full-project link at `lisp/roam/Noema`; the legacy
`lisp/roam/aaronnote` path remains as a compatibility symlink.

## Compatibility

The desktop host uses standalone mode and opens source targets in a new VS Code
window. The Emacs host keeps xwidget/Appine, buffer, gateway, and key-adapter
behavior. Existing lowercase `aaronnote` paths, `AARONNOTE_*` environment
variables, API channels, and `my/aaronnote-*` Lisp symbols are compatibility
contracts unless a migration explicitly replaces both sides.

## Two host adapters

Noema must support both host scenes without deleting or visually replacing
either adapter:

- In Emacs, `init-aaronnote.el` owns the existing header-line, transient menus,
  buffer integration, and every `my/aaronnote-*` entry point.
- In Noema.app, `desktop/main.mjs`, `desktop/preload.cjs`, and the
  `.noema-desktop-titlebar` renderer provide the macOS application menu,
  window title bar, drag/drop, and VS Code/new-window behavior.

The Emacs header-line is the functional reference for the App title bar:

| Emacs header control | Noema.app system title-bar control |
| --- | --- |
| back | Back |
| forward | Forward |
| reload | Refresh |
| pencil/editor actions | native Editor Actions menu |
| window/layout | native Window Actions menu |
| buffer name | current note filename |

Keep these command semantics shared through `runHostCommand`; host-specific UI
belongs only in its adapter. In the App, dropping only Markdown files opens
them in new Noema windows, Option-drop forces insertion, and mixed/non-Markdown
drops use the editor asset/text paste pipeline. Internal editor block dragging
must not be intercepted.

## Required checks

Run focused tests while editing, then:

```sh
make test
make build
make install
```

Verify the packaged host reports `hostMode: "desktop"` and that Emacs legacy
asset paths resolve into `resources/`. For a packaged UI check, launch:

```sh
NOEMA_DESKTOP_SMOKE=1 /Applications/Noema.app/Contents/MacOS/Noema
```

The report must show `preload: true`, `titlebarVisible: true`, a 54px title bar,
and the Back, Forward, Refresh, Editor actions, and Window actions controls.
