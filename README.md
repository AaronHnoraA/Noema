# Noema

> An Emacs-native, local-first environment for making the evolving structure of intellectual work explicit, persistent and navigable.

Noema is not a chat application, a Jupyter frontend, or a standalone Web/desktop app. Its primary object is the genealogy of work:

```text
problem
→ exploration and branches
→ experiments and artifacts
→ decisions and revisions
→ synthesis
```

AI agents, Jupyter kernels, terminals and ordinary programs participate in that structure; none of them defines the product model.

## Product boundary

**Emacs is the only supported Noema UI/UX and workspace compositor.** It owns buffers, windows, commands, navigation, DAG edits, execution launch/control, agent permissions and human intervention.

Noema does not build or support Electron, `Noema.app`, or an independent Web product shell. The Node host and Go kernel are headless services; Web technology remains part of the UI when Emacs hosts it.

This does not mean all rendering is rewritten in Elisp. Existing Web surfaces remain hosted and composed by Emacs:

- the private CodeMirror 6 Markdown knowledge surface;
- private Wiki and Graph views;
- Agenda and Configuration views;
- the right-side Jupyter/agent rich-output renderer, using JupyterLab `OutputArea`, rendermime, ipywidgets and live events.

These surfaces keep their mature editing, graph, filtering, navigation and rendering behavior. They do not become a second product shell or establish a second project, permission or durable-state authority. The shared output renderer displays agent replies for `.noema` and kernel output for ordinary Jupyter documents; it owns neither `.noema` structure nor execution authority.

## Core model

```text
Project
├── ordinary files and durable artifacts
├── *.noema active-work documents
├── WorkNode dependency DAG
├── execution and AgentSession records
└── explicit human intervention
```

The identities are deliberately separate:

```text
Cell != WorkNode != Artifact != AgentSession
document order != dependency order
```

- `WorkNode` is a structural unit such as a question, work item or checkpoint.
- `Dependency` connects WorkNodes (`lineage` or `depends`). The combined Work graph is acyclic.
- `Cell` is a question, work, checkpoint or note block in a `.noema` document. A work block uses nbformat `cell_type: "code"` only so it can carry outputs; it is not programming code.
- a Cell participates in a WorkNode through a stable `work_node_id` binding.
- `Artifact` refers to an ordinary project file or an immutable execution snapshot.
- `AgentSession` is an actor/lifecycle, not a WorkNode.

The graph records structure and provenance. It is not automatically an execution scheduler.

## Canonical files

`*.noema` is the canonical active-work document:

```text
research.noema
assignment.noema
proof-search.noema
```

The file is an inspectable nbformat 4.5 JSON container so stable Cell IDs, metadata and rich outputs round-trip through mature tooling. It has no `kernelspec`, no `language_info`, no programming-language blocks and no independent Result cells. Noema's WorkNodes, Dependencies and Cell bindings live in the `noema_research` namespace using `noema.work-document/2`.

The extension is Noema's product identity. `.ipynb` is only an interchange/export representation and must not become a shadow second authority. The Emacs textual projection is Noema's **JuText**; Jupytext is not currently used and may only become an optional interoperability adapter.

Markdown remains the durable knowledge surface. Source code, reports, datasets, figures and logs remain ordinary files usable without Noema.

A typical repository is:

```text
project/
├── noema.toml
├── noema-capabilities.json       # optional Skill/MCP selections and patches
├── research.noema
├── notes/
├── src/
├── experiments/
├── report/
├── .agents/skills/               # optional versioned project Skills
├── .noema/    # existing wiki-sync/vaultgit infrastructure
└── .agent/    # ignored runtime/index/CAS/view state
```

`.agent/` never replaces the authoritative `.noema`, Markdown or source files.

`noema.toml` marks the project root. Pi, sessions, views and the wiki repository all use the nearest manifest above a file. Visiting a `.noema` never creates a project, because previews and programs visit files too. Creating a `.noema` outside any project, or running its first work block, asks where to create the manifest. The prompt proposes the enclosing `project.el` workspace root, or the file's own directory when there is none. Declining writes nothing. `M-x noema-project-enable` uses the same default.

## Emacs workflow

Opening `research.noema` visits the real file in `noema-research-mode`. JuText supplies block navigation and editing while stable IDs remain hidden. Work prompts may begin with `@@agent(id)`, `@@session(continue|fork|fresh|name|parent:child)`, repeated `@@ctx(ref)` and `@@skill(id)` directives. `@@ctx(lineage:N)` widens the ancestor context to N (1–3) levels and `@@ctx(none)` turns off the context Noema attaches automatically; automatic context (derived lineage and upstream outputs) only uses the 64 KiB budget declared context leaves, and anything it cannot fit is recorded as `context_omitted` in the RunSpec. `C-c C-c` strips that leading control region, freezes a RunSpec and dispatches the body through the configured ACP agent.

Project Skills and MCPs are resolved from built-in, global, explicitly shared
and project scopes before that RunSpec is frozen. `M-x noema-capability-manager`
shows effective state, source, patches, validation and MCP runtime state; in an
agent-shell buffer the same command becomes a read-only lookup that drafts a
reference to the selected capability's source. See
[Project Skills and MCP capabilities](docs/capabilities.md) and the
[semantic Elisp API](docs/noema-elisp-api.md).

Key commands include:

| Key | Action |
|---|---|
| `C-c C-n` | continue from current context with a downstream WorkNode |
| `C-c C-s` | create a sibling WorkNode |
| `C-c C-g` | temporarily pop up the Work DAG |
| `C-c C-b` | bind the current Cell to a labeled WorkNode |
| `C-c C-c` | run the current work block through its configured agent |
| `C-c j r` | run a selected project `.py` / `.ipynb` from the current WorkNode |
| `C-c C-o` | open/update the right-side rich-output renderer |
| `Cmd-Enter` | sync/activate the right-side OutputArea (same convention as Jupyter) |
| `C-c C-z` | cancel the Noema execution of the cell at point, whether running, queued or still being prepared |
| `C-c C-f` | set or clear the document's default agent |
| `C-c j x` / `C-c j X` | clear current/all outputs |
| `C-c j u` | unbind the current Cell while preserving its WorkNode |
| `C-c j d` | delete the current Cell while preserving its WorkNode |
| `C-c j w` | delete the current WorkNode while preserving its Cells as notes |
| `C-c j C` | inspect and manage effective project Skills/MCPs |
| `C-c M-m` | explicitly migrate a pre-D-023 `.noema` document |

While a Run is active, OutputArea shows a lightweight status card and updates
the durable result only when the Run finishes.  A cell's context menu can opt
that cell into provisional live output.  **Open Agent** reuses or resumes the
exact named Session in the one bottom-right Agent window; a project's
conversations appear there as tabs instead of opening additional panes, and
each tab is that Session's own interactive agent-shell buffer
(`C-c C-a`/`C-c C-n`/`C-c C-p` switch sessions; right-click a tab to stop,
restart, close, rename, fork or archive it; `?` lists every key).  A finished
Run leaves a fresh input prompt (`C-c C-e`).  `@@session` keywords are exactly
`continue`, `fork` and `fresh`; lookalikes such as `refresh` are rejected with a
suggestion instead of silently naming a session.  Re-running a block restarts it
from the document and its upstream state instead of stacking a second attempt:
a session only that block uses keeps its name under a new generation, a shared
one branches.  Every new conversation receives the project root, document path,
work title and its lineage blocks.  The kernel approves reads, edits and commands
inside the project; anything outside it or on the network opens Attention for a
decision, and credentials, privilege elevation, `git push` and history rewrites
are always refused.  Straight lineage
continues one Session (and queues while it is busy), while an actual DAG branch
gets a separate named conversation.  A terminal reply replaces that work
block's latest `outputs` with Markdown/plain-text MIME plus
`application/vnd.noema.run+json`; Run history remains in the Run store and the
optional agent-shell Markdown transcript is disabled for Noema Runs.  Clearing
outputs does not delete a Run. Clicking **Open Source in Emacs** sends
`scriptFile + cellId`; Emacs resolves the stable Cell identity instead of
trusting a projected line number. Agent Runs snapshot newly created or modified
ordinary files into the CAS without moving them, persist `ArtifactLink`
provenance on the stable WorkNode, and expose those paths through the Emacs
Inspector.

The Work DAG opened by `C-c C-g` is a semantic Graph Board rather than a
static diagram. It is a temporary pop-up, not a default/dedicated workspace
window: `RET` or double-click synchronizes its selected node back to JuText
and closes it; `q` dismisses it. Opening `.noema` instead defaults to JuText
plus the right-side OutputArea, and it never auto-opens or auto-follows DAG.
Work state, outcome, active Run status, dropped reason and checkpoint shape
are visible on the graph. `TAB` fixes a fold, `f` makes the selected node the
root of the drawing (`^` moves that root up, `[`/`]` change its depth), and
`z` cycles Overview / Branch / Detail; Detail projects the latest Run and
linked artifacts. Overview and manual folds retain the selected/focused path.
Use `?` for contextual help, `h/j/k/l` or arrows for geometric graph
navigation, `e` for the Agent/Project Run menu, `F` to fork directly, and `X`
for identity-safe WorkNode / Cell structure actions. View state lives under
`.agent/views/` and does not change the `.noema` document.

`.noema` never starts, attaches, restarts or selects a Jupyter kernel and has no Run All command. Ordinary `.ipynb` and Markdown `@@cell` sidecars retain the complete Jupyter workflow. Programming code and experiments belong in ordinary project files.

Agenda, configuration and private Wiki/Graph are not standalone Web products, but their existing Web surfaces are retained. Emacs commands open `/agenda`, `/config`, `/wiki` and `/graph` inside Emacs-owned xwidget/Appine buffers. Source files remain normal Emacs buffers; Markdown remains an ordinary file while the Emacs-hosted CM6 surface supplies its rich editing experience. The retained `jupyter.html` route is the right-side rich-output renderer. Server mode separately restricts Wiki publication to read-only behavior.

## Internalized AI implementation

Noema directly carries the complete source of gptel, agent-shell, acp.el,
shell-maker and Magent under `upstream/`. They are not installed as Noema
package dependencies, and Noema does not replace them with partial rewrites.

- gptel supplies compose, arbitrary-buffer send, context, transient controls
  and rewrite/diff review;
- agent-shell + acp.el supply structured processes, sessions, streaming,
  permission and input interaction;
- Magent supplies the local agent, queue, ledger and gptel adapter;
- Noema supplies the public entry points and Project/WorkNode/Run/Artifact
  integration.

Noema-specific Emacs code lives in `lisp/`. `noema-agent-acp.el` is the single
research/runtime coupling boundary to agent-shell/acp implementation details.
Versions and licenses are recorded in [UPSTREAMS.md](UPSTREAMS.md).

## Architecture

```text
                         USER
                           │
                           ▼
                        Emacs
          ┌────────────────┼─────────────────┐
          ▼                ▼                 ▼
    .noema / JuText     Work DAG       ordinary files
          │                │                 │
          ├──────── Emacs-hosted Web views ─┤
          │ CM6 · Wiki/Graph · Agenda/Config│
          │       Jupyter rich output       │
          └────────────────┬─────────────────┘
                           ▼
                  Noema project model
                  ┌────────┴─────────┐
                  ▼                  ▼
          Node runtime/agent     Go research store
                  │                  │
                  └──── agents ──────┘
```

The Node host owns transport, Jupyter processes/events, document services and renderer assets. The Go kernel owns project-local research/runtime indexes, append-only events, CAS and MCP data access. External agents remain independent processes, normally integrated through ACP/agent-shell.

Existing `AARONNOTE_*`, `aaronnote:api:*` and `init-aaronnote.el` names are retained only as wire/file compatibility contracts. New Emacs product commands use `noema-*` or `my/noema-*` names.

## Build and install

Node `26.5.0` and npm `11.17.0` are pinned.

```sh
nvm install
nvm use
make setup
make test
make build
make install
```

`make build` creates the renderers consumed by Emacs and the headless Go kernel. `make install` links only `noema-kernel` into `~/.local/bin`; it creates no app bundle and installs nothing under `/Applications`.

The note root defaults to `~/Documents/Noema`. The runtime can be pointed at another root when Emacs starts the host:

```sh
export NOEMA_ROOT="$HOME/Documents/Noema"
export NOEMA_RESOURCES_ROOT="/path/to/Noema/resources"
```

## Demonstration

The current end-to-end project is `~/Desktop/Noema-Research-Demo`.

Open `~/Desktop/Noema-Research-Demo/research.noema` normally in Emacs. No project-specific `.command` or launcher file is part of the design.

It opens an Emacs workspace containing a v2 `.noema` WorkDocument, WorkNode DAG and right-side output renderer. `Repair under approximate reversibility` demonstrates `@@agent(codex)` plus `@@ctx(lineage)`. The former Python Cell was migrated to the ordinary `experiments/scaling.py` file, which can be run outside `.noema` and still writes `experiments/scaling.json`.

## Publishing reader

The repository still contains a read-only server renderer for publishing Markdown. It is an output/publication surface, not a Noema control UI: authoring, Jupyter, permissions, agents, Proposals and Run control are denied. See `server-config/` and `docs/wiki-workspace.md` for that separately scoped service.

## Development map

- `server/lib/research-notebook.mjs`: `.noema` v2 model, migration, validation and graph operations.
- `server/lib/research-runtime.mjs`: directive parsing, deterministic agent/session routing, RunSpec freezing and terminal output write-back.
- `server/lib/noema-capabilities.mjs`: Skill/MCP discovery, scope resolution, patches, validation and provenance.
- `server/lib/jupyter-cell.mjs`: ordinary Jupyter document/session service plus a kernel-free read-only `.noema` output snapshot.
- `aaronnote/main.ts`, `wiki-main.ts`, `agenda-main.ts`, `config-main.ts`: Emacs-hosted Markdown and knowledge/work surfaces.
- `aaronnote/jupyter-main.ts`: Emacs-hosted output-only renderer.
- `src/jupyter-rendermime.ts`: JupyterLab OutputArea/rendermime integration.
- `kernel/noema/research/`: Go research/runtime store, indexes, events and CAS.
- `lisp/noema-research*.el`: JuText, WorkNode model, graph, inspector and synthesis.
- `lisp/noema-api.el`, `lisp/noema-capability-ui.el`: public semantic API and Emacs capability manager.
- `lisp/noema-agent*.el`: ACP boundary, AgentSession worker, promotion and takeover paths.
- `lisp/noema-compose.el`, `lisp/noema-interaction*.el`: gptel UI entry points and migrated interaction/CLI fallback behavior.
- `upstream/`: complete internalized gptel, Magent and existing CLI compatibility sources. agent-shell, acp.el and shell-maker are pristine package-vc dependencies (see `UPSTREAMS.md`).

The authoritative product model is maintained in `~/Desktop/]/DESIGN.md`, with decisions in `DECISIONS.md` and the long-running implementation prompt in `BOOTSTRAP.md`.

## License

AGPL-3.0-only. The source-editor infrastructure includes attributed adaptations from Overleaf; see `NOTICE` and `docs/architecture/overleaf-source-editor-study.md`.
