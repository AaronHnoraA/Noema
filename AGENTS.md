# Noema maintenance

Noema is a standalone application. The canonical source tree is this
repository; Emacs integrates through compatibility links and must never become
a runtime dependency of the desktop app.

The repository lives at `~/HC/SOURCE/Noema`; its `origin` must remain the
literal SSH-style remote `$MY_GIT:Noema/Noema.git`.

## Environment

- Node is exactly `26.5.0`; npm is exactly `11.17.0`.
- Use `nvm install && nvm use`, then `make setup`.
- Use `npm ci`, not an unlocked dependency install, for reproducible setup.
- The default note root is `~/Documents/Noema`. `NOEMA_ROOT` may override it.
- The desktop app must create a missing note root before starting the host.

## Shared assets

`resources/` is the source of truth for snippets, templates, TeX/KaTeX macros,
and prose words. Emacs uses the full-project link at `lisp/roam/Noema`; the
legacy `lisp/roam/aaronnote` path remains as a compatibility symlink.
Historical asset paths are also symlinks into this repository. Do not move
asset ownership back into the Emacs configuration.

## Compatibility

The desktop host uses standalone mode and opens source targets in a new VS Code
window. The Emacs host keeps xwidget/Appine, buffer, gateway, and key-adapter
behavior. Existing lowercase `aaronnote` paths, `AARONNOTE_*` environment
variables, API channels, and `my/aaronnote-*` Lisp symbols are compatibility
contracts unless a migration explicitly replaces both sides.

## Required checks

Run focused tests while editing, then:

```sh
make test
make build
make install
```

Verify the packaged host reports `hostMode: "desktop"` and that Emacs legacy
asset paths resolve into `resources/`.
