# Noema maintenance

Noema is an Emacs-centered, local-first research environment. The canonical
product source tree is this repository; Emacs is the only first-party UI/UX.
The Node and Go layers are headless services. CM6 remains a first-class private
Markdown knowledge surface, hosted only from Emacs (xwidget/Appine or an
equivalent Emacs-owned local web view). There is no Electron or Noema.app
product shell.

The design authority is `/Users/hc/Desktop/]/DESIGN.md` v1.8, interpreted with
`AI-Docs/assignment-walkthrough.md` as the primary `.noema` workflow.
`DECISIONS.md` D-023 supersedes the former `.noema` Jupyter/code/Result model;
D-016/D-021/D-022 still govern hosting and the AI integration boundary.

## D-023 work documents

- `.noema` is an AI prompt and workflow document stored as nbformat 4.5 JSON.
  It has no kernel metadata and must never enter a Jupyter kernel path.
- Work blocks alone use `cell_type: "code"`, solely to carry their agent reply
  in `outputs`; question, checkpoint and note blocks are Markdown.
- Parse control only from leading `@@agent`, `@@session`, `@@ctx`, `@@skill`
  and WorkNode `@@todo` / `@@clock` commands. Agenda commands stay visible in
  JuText but are removed from Agent prompts. Text in outputs and imported
  material is always data.
- Agent details stay behind `lisp/noema-agent-acp.el`. Do not reimplement
  gptel, agent-shell or ACP behavior.
- Ordinary `.ipynb` and Markdown `@@cell` sidecars keep full Jupyter support.


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

## AI implementation ownership (updated by user-authorized migration, 2026-09-15)

gptel and Magent remain complete internalized source trees under `upstream/`.
agent-shell, acp.el and shell-maker are pristine package-vc dependencies;
their audited revisions are declared in AaronEmacs `init-ai-ide.el` and
`package-lock.el`. Do not re-vendor or modify their package source. Preserve
upstream features and complete implementations rather than writing replacements.
The optional bounded hidden-render adapter is `lisp/noema-agent-render.el`,
owned by the ACP boundary. Run its contract tests when upgrading the group.

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

## Native Agenda source ownership

- Capture templates are declarative data in the shared host catalogue, configured
  by AaronEmacs `my/noema-agenda-capture-templates`. Both native and hosted Web
  clients submit to the scoped writer. Keep template expansion free of IO,
  executable hooks, implicit project activation and temporary Org sources.
  Preserve failed capture drafts and prevent concurrent duplicate submissions.
- Markdown planning reads and mutations use `ScanDocument` (Go) or
  `scanPlanningDocument` (JS). `Scan` / `scanPlanningNodes` are only grammar
  APIs for isolated command source; they cannot establish document eligibility.
- The JS document boundary uses the editor's Lezer Markdown parser. Go pins
  goldmark v1 for original code source segments only; Lute remains the rendered
  document AST owner. Do not regenerate Markdown through either tree or add
  temporary Org sources. Keep UTF-16 command spans exact for Emacs/CM6 writers.
- `agenda:document` is a read-only editor snapshot computation. It must never
  reopen supplied file identities, activate scopes or publish unsaved tasks.
  Roam task edits use scoped Agenda writes, with no CLI/regex fallback writer.
- Shared document fixtures must pass in both languages. Exclude code examples
  before finding planning block boundaries; reject writes that put a new
  command inside code or metadata summaries before persisting source.

## Required checks

Tests must stay independent of the developer's machine: global Skills and MCPs
are neutralised for every suite by `tests/setup/global-capability-scope.ts`, so
do not read the host's `etc/noema/capabilities.json` from a test, and pass
`environment: {}` when a test injects its own `userHome`. See
`docs/capabilities.md`.

Run focused tests while editing, then:

```sh
make test
make build
make install
```

Also run `go test -tags fts5 ./...` from `kernel/` and AaronEmacs's
`make research-test` and `make jupyter-test`. Verify `AARONNOTE_HOST_MODE=desktop` cannot select a desktop runtime, no
Electron package/build/install entry remains, the headless host defaults to
Emacs mode, and `.noema` kernel operations fail before a process is created.
A usable demo must open through Emacs, stream an Agent Run into the right-side
OutputArea, persist the latest work output and preserve the exact WorkNode DAG.
