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
- Parse control only from leading `@@agent`, `@@session`, `@@ctx`, `@@skill`,
  `@@pack` and WorkNode `@@todo` / `@@clock` commands.  A pack is a link list
  of flat Skill ids resolved by `noema-capabilities.mjs`; never copy Skill
  content into a pack or let a pack patch change member content
  (`docs/capabilities.md`, "Skill packs"). Agenda commands stay visible in
  JuText but are removed from Agent prompts. Text in outputs and imported
  material is always data.
- Agent details stay behind `lisp/noema-agent-acp.el`. Do not reimplement
  gptel, agent-shell or ACP behavior.
- A whole plan is one Proposal: `graph.declare` carries the blocks and the
  references between them, is accepted or rejected as one unit, and is written
  by `createCells` under a single revision compare-and-swap. A half-agreed
  plan must never reach the document, so do not materialize its cells one
  call at a time. `cell.create` remains the single-block form.
- A Run may report the state of the WorkNode it owns, and nothing else. The
  `research_state` MCP tool does not apply that report: it records a durable
  `worknode.state` coordinator request, and Emacs claims it and applies it
  through the same validated, undoable structure transaction a person's edit
  uses. Keep it that way — the document has exactly one authority, and the
  kernel is not it. Structure changes (new nodes, new edges) remain
  Proposals. Agent tool activity schedules the claim, so a Run's bookkeeping
  does not wait for Pi.
- **Refuse, warn, or leave to judgement.** Structural corruption is refused:
  cycles, unknown states, duplicate ids, a Run reporting on a node it does not
  own, a plan materialized in halves. An unsupported *claim* is a different
  thing and is only warned about — `done` with no Run and no outcome, a `done`
  node whose last Run failed, a `done` node above a `regressed` one, an
  `active` node with no Run. Warnings go through the `:warnings` channel of
  `noema-research-validate`, which `noema-research-structure-edit` never
  diffs, so a notice can never become a gate. Modelling judgement — whether a
  block is a unit of work, whether an edge really means "uses" — is neither,
  and belongs in a Skill. When adding a check, decide which of the three it is
  first; a timing rule enforced as a refusal teaches people to lie to the
  system.
- **Two projections, two meanings of focus.** `noema-research-projection'
  (Emacs, drives the Graph Board) keeps only the focus and its descendants;
  `researchGraphProjection` (Node, rides on every notebook snapshot for the
  web surface) also keeps the focus's ancestors and siblings. Both are
  asserted by tests. This is a product decision nobody has made, not a bug to
  quietly fix on one side: changing either changes what a person sees, so
  decide first and move both sides and their tests together.
- **Report, do not decide.** `SourceChanges` answers "have the files this
  claim was verified against moved?" from `artifact_links` and the
  content-addressed digests the Runs already wrote. It never changes a
  WorkNode's state, and neither should anything built on it.
- **Reviewed memory is a frozen projection.** Run preparation may attach only
  relevant, evidence-backed, non-local Findings from the current workstream as
  low-priority automatic context. Explicit `@@ctx(none)` suppresses it. Handoff
  excerpts enter as pending `finding.create` Proposals; only a person's
  evidence review may promote one to `supported`/`human_reviewed`. Do not infer
  a durable fact from a transcript, a retrieval hit or a Pi coordinator reply.
- **Retiring a Finding is a person's act, and one-way.** `RetireFinding`
  moves a Finding to `disputed`, `refuted` or `superseded` with a reason and a
  version compare-and-swap, and refuses any reviewer that is not `human:`. It
  deletes nothing: evidence and history stay, and the Finding only leaves
  automatic recall. There is no way back by edit; a retired claim returns
  through a new evidence review. Do not add an agent-facing tool for it or a
  "reinstate" shortcut.
- **Similarity is a notice.** Near-identical Findings and page titles are
  reported to the person (`similarFindings`, `reports.similar`); the only
  identity the system acts on stays exact (`semantic_sha256`, the canonical
  title). Do not turn a similarity score into a refusal or an automatic merge.
- **Recorded is not applied.** `research_state` writes a durable request; the
  editor applies it. Say so in the result and give the agent
  `{action: "status"}` to find out, rather than letting it assume the document
  changed.
- `regressed` is never a lone node property. Every path that sets it goes
  through `noema-research-op-set-state`, which delegates to
  `noema-research-op-set-regressed` so the state always carries to the `done`
  work below it. Do not add a second way to set it.
- Ordinary `.ipynb` and Markdown `@@cell` sidecars keep full Jupyter support.


## D-038 Project model

- `noema.toml` declares a Wiki **repository** (top-level `repository_id`,
  written by Wiki registration into every vault Git repository) and,
  independently, a research **Project** (a `[project]` table with `id` and an
  optional `workspace`). Never treat a repository manifest as a Project: that
  is how a whole vault used to become one research project.
- One rule, two implementations kept in step: `noema-project-root` (Elisp)
  and `server/lib/research-project.mjs` (Node) both take the nearest manifest
  with `[project]`, or a pre-D-038 manifest with `.agent/state.sqlite` beside
  it. Every other resolver delegates: grouping outside a Project uses
  `noema-project-scope`, never its own fallback chain.
- Paths reaching the host are native. Elisp projects `/fs:` names through
  `noema-project-client-path`; Node refuses logical and TRAMP names with
  `ERR_RESEARCH_ROOT` rather than guessing.
- A Project is not a Git concept. Do not derive it from `project.el` except as
  the *proposal* for a new one in a code repository, and do not edit a
  person's `.gitignore`; `.agent/` ignores itself.
- `cwd` in a request only locates the Project; send `root` when the caller
  knows it. A Run executes in `executionTarget`, else the Project workspace.
  Files are readable only under the root or the workspace, and artifact paths
  stay root-relative (a workspace outside yields `../` paths, which the
  kernel's content-addressed links resolve unchanged).
- Resumed sessions start in their recorded `executionTarget`: an agent finds a
  native conversation by the directory it ran in.

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
`agent-shell-fork-tree` is likewise a pinned, pristine package-vc dependency.
Noema enters it through `noema-agent-acp.el`, registers native branches as
named Agent sessions, and keeps its text index in memory. Its shared-history
tree is a navigation view, not a WorkNode DAG or authoritative `parentName`.
The optional bounded hidden-render adapter is `lisp/noema-agent-render.el`,
owned by the ACP boundary. Run its contract tests when upgrading the group.

Noema product entry points and adapters live under `lisp/`. gptel owns the
composition/context/rewrite UI, agent-shell + acp.el own structured process and
session interaction, and Magent supplies its local agent/queue/ledger/gptel
adapter. `noema-agent-acp.el` is the sole research/runtime coupling boundary
to agent-shell/acp implementation details.

`noema-context.el` hands editor context to one chosen live session. It reuses
gptel's selection whole -- the `gptel-context' variable, its region overlays
and its `*gptel-context*' review buffer -- so there is one selection, not two.
What it sends is always a reference: a `path:START-END' line in the prompt
text plus one `resource_link' block per file. Do not add an embedded
`resource' or inlined file text to this path; the point is that attaching a
file costs a line rather than a copy. Reach agent-shell internals only through
`noema-agent-acp-file-uri', `-file-metadata' and `-enqueue'.

Every agent session is registered per project by `noema-agent-acp-adopt',
whatever started it: a Run, the popup pool, `noema-agent-start' or a bare
`M-x agent-shell'. `noema-agent-acp-start' records the entry point as
`:origin'. Root resolution (`noema-agent-acp-project-root') is a query and
must stay one: registering a session never creates a Project. A project
that already has one also gets a durable `session:promote' + `session:name:bind';
elsewhere the session is listed from Emacs alone.

## Agent lifecycle and attention (adopted from Pisper, 2026-09-28)

See `docs/pisper-agent-lifecycle-study.md` for every accept/reject decision.

- **Attention is derived, never stored.** A session name's `unread`,
  `failed`, `needsAttention` and `attentionReason` are projected by the kernel
  from its latest Run and `read_at`; only reading is a write. Reading clears
  `unread` and nothing else: a failure stays until a later Run succeeds, and a
  pending permission or input outranks it. Never infer attention from file
  mtimes or UI state.
- **Failure kinds are projections of the reason.** `ClassifyRunFailure` sets
  `failureKind`/`retryable` on read. Only rate limit, network and lost lease
  are retryable. Nothing retries a Run automatically: a Run has side effects,
  so a retry is the person's `R`, which asks first for non-retryable kinds.
- **Freezing is serial, execution is bounded-parallel.** A Run holds the
  Magent queue ticket only until it is dispatched
  (`noema-agent-worker--release-arbiter`); `noema-agent-worker--slot-free-p`
  is checked by the ticket holder, the only code that adds to
  `noema-agent-worker--runs`, so the cap cannot be overshot.
- **Concurrent edits wait; they are not refused.** `concurrentEditReasonTx`
  withdraws auto-approval when another open Run of the same target was
  allowed to edit the path, and records why in `policyReason`. Remembered
  allow rules do not bypass it; reject rules still win.
- **Redact copies, not originals.** `RedactSecrets` applies where Noema keeps
  a copy that outlives the moment: stored failure reasons and the history
  index. Native transcripts and CAS evidence stay exact.
- **Side chats are ephemeral.** Origins in
  `noema-agent-acp-ephemeral-origins` never reach the durable registry and
  are auto-stoppable. Queued agent-shell prompts protect a session from every
  automatic stop, as a running turn does. agent-shell owns the prompt queue
  and steering; Noema only reads the queue length.

## Skills

Skills live in two places, and the split is about versioning, not taste:

- `resources/skills/` — Skills that describe **Noema's own mechanisms**
  (`noema-work-dag`, `noema-elisp-api`). They ship with the code because they
  are only correct for the code they ship with.
- `<NOEMA_ROOT>/public/README/Skills/skills/` — the growable library, wired
  through `NOEMA_GLOBAL_SKILLS` (defaulted by `my/noema-skills-directory` in
  AaronEmacs). Skills are knowledge: they live beside the notes, are versioned
  by the same git, found by the same search, and can be added to without a
  Noema release. The library is laid out as a Portable Agent Plugin
  (`plugin.json`, `mcp.json`, `skills/<id>/SKILL.md`, optional per-skill
  `references/`, `assets/`, `scripts/`, `agents/openai.yaml`), so a skill from
  another project drops in and this one is portable out.

One convention for both, the portable one: `<kebab-id>/SKILL.md` with YAML
`name` and `description`, so a skill from another project drops in unchanged.
Depth belongs in `references/<topic>.md`, which the resolver lists and the
agent reads on demand — a SKILL.md that must be read in full on every Run
taxes every Run, and over ~8 KiB the resolver says so. Keep the rules a
mechanism now carries *out* of the Skill; a Skill that repeats what the system
enforces gives two sources of truth for one rule.

JuText `@@skill` candidates come only from the project's effective selectable
Skill records. Its Company backend keeps directive completion separate from
prose and manual Yasnippet templates, including while the capability request
is pending. `.noema` has no language server; Flymake projects the existing
document validator onto cell headers. RaTeX previews math in JuText prose,
excluding control lines and fenced or inline code.

## Two MCP surfaces

The knowledge base and the AI workflow are separate capabilities on separate
endpoints, and must not be conflated:

| Endpoint | Tools | Capability id |
|---|---|---|
| `/mcp` | notes, search, blocks, tags, templates | `noema-knowledge` |
| `/mcp/research` | `research_cell`, `research_run`, `research_state`, `artifact`, `proposal.create` | `noema-research` |
| `/mcp/coordinator` | Pi's session verbs | — |

One registry still; the endpoints differ only by their projection predicate
(`tools.SurfaceForTool`). A tool without a `Surface` is knowledge, so adding
one cannot silently widen the research surface. The historical single id
`noema` is expanded to both wherever a config mentions it, because a project
that disabled `noema` meant all of it.

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
