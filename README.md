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

These surfaces keep their mature editing, graph, filtering, navigation and rendering behavior. They do not become a second product shell or establish a second project, permission or durable-state authority. The Jupyter output renderer specifically displays computation; it does not own `.noema` Cell structure or execution authority.

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
- `Cell` is a Markdown, code or result unit in a `.noema` document.
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

The v1 file remains an inspectable nbformat 4.5 JSON container so the existing Jupyter execution and output machinery round-trips correctly. Noema's WorkNodes, Dependencies and Cell bindings live in the `noema_research` namespace using `noema.work-document/2`.

The extension is Noema's product identity. `.ipynb` is only an interchange/export representation and must not become a shadow second authority. The Emacs textual projection is Noema's **JuText**; Jupytext is not currently used and may only become an optional interoperability adapter.

Markdown remains the durable knowledge surface. Source code, reports, datasets, figures and logs remain ordinary files usable without Noema.

A typical repository is:

```text
project/
├── noema.toml
├── research.noema
├── notes/
├── src/
├── experiments/
├── report/
├── .noema/    # existing wiki-sync/vaultgit infrastructure
└── .agent/    # ignored runtime/index/CAS/view state
```

`.agent/` never replaces the authoritative `.noema`, Markdown or source files.

## Emacs workflow

Opening `research.noema` visits the real file in `noema-research-mode`. JuText supplies Cell navigation and editing while stable IDs remain hidden. The user can create or bind code Cells under the current contextual WorkNode without typing IDs.

Key commands include:

| Key | Action |
|---|---|
| `C-c C-n` | continue from current context with a downstream WorkNode |
| `C-c C-s` | create a sibling WorkNode |
| `C-c C-g` | open the Work DAG |
| `C-c C-e` | insert a code Cell in the current WorkNode context |
| `C-c C-b` | bind the current Cell to a labeled WorkNode |
| `C-c C-c` | execute by Cell role: code → Jupyter; work → CLI agent Run |
| `C-c C-o` | open/update the right-side rich-output renderer |
| `C-c C-z` | interrupt execution |
| `C-c j a` | run all code Cells |
| `C-c j x` / `C-c j X` | clear current/all outputs |
| `C-c j r` / `C-c j k` | restart/shut down kernel |
| `C-c j K` | select or attach a kernel in Emacs |

Execution streams incrementally into the right-side renderer. Clicking **Open Source in Emacs** sends `scriptFile + cellId`; Emacs resolves the stable Cell identity instead of trusting a projected line number. Agent Runs snapshot newly created or modified ordinary files into the CAS without moving them, persist `ArtifactLink` provenance on the stable WorkNode, and expose those paths through the Emacs Inspector.

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
          Node runtime/Jupyter   Go research store
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

It opens an Emacs workspace containing a v2 `.noema` WorkDocument, WorkNode DAG and right-side Jupyter output renderer. The demo has a real Python Cell bound to a WorkNode and emits incremental output.

## Publishing reader

The repository still contains a read-only server renderer for publishing Markdown. It is an output/publication surface, not a Noema control UI: authoring, Jupyter, permissions, agents, Proposals and Run control are denied. See `server-config/` and `docs/wiki-workspace.md` for that separately scoped service.

## Development map

- `server/lib/research-notebook.mjs`: `.noema` v2 model, migration, validation and graph operations.
- `server/lib/jupyter-cell.mjs`: Jupyter document/session service and canonical `.noema` output writes.
- `aaronnote/main.ts`, `wiki-main.ts`, `agenda-main.ts`, `config-main.ts`: Emacs-hosted Markdown and knowledge/work surfaces.
- `aaronnote/jupyter-main.ts`: Emacs-hosted output-only renderer.
- `src/jupyter-rendermime.ts`: JupyterLab OutputArea/rendermime integration.
- `kernel/noema/research/`: Go research/runtime store, indexes, events and CAS.
- `lisp/noema-research*.el`: JuText, WorkNode model, graph, inspector and synthesis.
- `lisp/noema-agent*.el`: ACP boundary, AgentSession worker, promotion and takeover paths.
- `lisp/noema-compose.el`, `lisp/noema-interaction*.el`: gptel UI entry points and migrated interaction/CLI fallback behavior.
- `upstream/`: complete internalized gptel, agent-shell, acp.el, shell-maker, Magent and existing CLI compatibility sources.

The authoritative product model is maintained in `~/Desktop/]/DESIGN.md`, with decisions in `DECISIONS.md` and the long-running implementation prompt in `BOOTSTRAP.md`.

## License

AGPL-3.0-only. The source-editor infrastructure includes attributed adaptations from Overleaf; see `NOTICE` and `docs/architecture/overleaf-source-editor-study.md`.
