# Noema maintenance

Noema is an Emacs-centered, local-first research environment. The canonical
product source tree is this repository; Emacs is the only first-party UI/UX.
The Node and Go layers are headless services. CM6 remains a first-class private
Markdown knowledge surface, hosted only from Emacs (xwidget/Appine or an
equivalent Emacs-owned local web view). There is no Electron or Noema.app
product shell.

The design authority is `/Users/hc/Desktop/]/DESIGN.md`, interpreted with
`AI-Docs/HCI.md` and `AI-Docs/设计和demo.md` as the primary HCI specifications.
`DECISIONS.md` D-016/D-021/D-022 supersede the former dual-host, Web-surface
retirement and split-source assumptions.


## Environment

- Node is exactly `26.5.0`; npm is exactly `11.17.0`.
- Use `nvm install && nvm use`, then `make setup`.
- Use `npm ci`, not an unlocked dependency install, for reproducible setup.
- The default note root is `~/Documents/Noema`. `NOEMA_ROOT` may override it.
- Emacs startup must create a missing note root before starting the host.

## Shared assets

`resources/` is the source of truth for Noema-owned assets such as:

- `templates/noema/`, `templates/latex/`, and `templates/tex/`
- `katex-macros/` and `prose-accepted-words.txt`

Markdown and TeX snippets are now owned directly by AaronEmacs at
`~/.config/emacs/snippets/{markdown-mode,tex-mode}`. `resources/snippets` is a
relative link to that one canonical copy. Do not recreate an external source
copy or make AaronEmacs link back to one.

`site-lisp/noema` is the real project directory inside AaronEmacs, not a
full-project symlink. The retired `/Users/hc/HC/SOURCE/Noema`,
`lisp/roam/Noema` and `site-lisp/ai-workbench` paths must not be reintroduced.

## Internalized AI implementation

The complete gptel, agent-shell, acp.el, shell-maker and Magent source trees
under `upstream/` are part of the canonical local source. Reuse them directly;
do not install them as Noema package dependencies, mechanically rename their
features, or write reduced replacements. Preserve their tests, docs, assets,
prompts, attribution and licenses until real workflows justify pruning.

Noema product entry points and adapters live under `lisp/`. gptel owns the
composition/context/rewrite UI, agent-shell + acp.el own structured process and
session interaction, and Magent supplies its local agent/queue/ledger/gptel
adapter. `noema-agent-acp.el` is the sole research/runtime coupling boundary
to agent-shell/acp implementation details.

## Host and compatibility

`init-aaronnote.el` owns the CM6 xwidget/Appine lifecycle, header line, buffer
integration, gateway, and every `my/noema-*` entry point. Graph Board, JuText,
Inspector, approvals and project navigation are composed by Emacs. CM6
Markdown, private Wiki/Graph, Agenda/Config and Jupyter output retain their
Web implementations as Emacs-hosted surfaces; do not delete or downgrade them,
and do not add a parallel browser or desktop workflow product.

Existing lowercase `aaronnote` paths, `AARONNOTE_*` environment variables and
API channels remain protocol compatibility contracts until separately
migrated. They do not imply a second product host. The Emacs Lisp public
surface uses `my/noema-*`; do not add new `my/aaronnote-*` aliases.

Chrome plus the Noema extension is an explicit external capture boundary, not
a Noema UI. Public server pages are read-only publication surfaces, not an
authoring/control-plane replacement for Emacs.

## Required checks

Run focused tests while editing, then:

```sh
make test
make build
make install
```

Verify `AARONNOTE_HOST_MODE=desktop` cannot select a desktop runtime, no
Electron package/build/install entry remains, the headless host defaults to
Emacs mode, and the Emacs research tests cover the Graph Board/JuText vertical
slice. A usable demo must open through Emacs and persist exact notebook graph,
focus/fold view state, and text across restart.
