# Noema

An Emacs-centered, local-first Markdown knowledge and project workspace.
Project work lives in ordinary documents, with Agent guidance in `AGENTS.md`
and durable runtime records under `.agent/`.

## Product boundary

Emacs owns buffers, windows, commands, Agent processes, Sessions, permissions
and user interaction. Node and Go are headless services. There is no Electron
or standalone Noema desktop shell.

Emacs hosts the CodeMirror Markdown editor, private Wiki/Graph, Agenda,
configuration and the ordinary Jupyter output page. The shared JupyterLab
OutputArea/rendermime/ipywidgets stack remains available to `.ipynb` notebooks
and Markdown `@@cell` sidecars. Notebook source projection, completion, LSP,
kernel controls and rich output remain independent of the retired work-document
adapters.

## Documents and projects

```text
project/
├── AGENTS.md              instructions and document entry points
├── docs/                  questions, plans, evidence and conclusions
├── code, data, papers     ordinary working material
├── noema.toml             optional durable Noema Project declaration
└── .agent/                runtime records, artifacts and optional handoffs
```

Use the project's existing document layout rather than requiring this exact
tree. Noema's durable project services use the nearest `noema.toml` containing
`[project]`; an independent top-level `repository_id` declares a Wiki Git
repository. A vault can contain many projects. Ordinary Agent sessions remain
usable outside a declared Noema Project.

A Project can declare a separate `workspace` for Agent execution. `cwd` locates
the Project; `executionTarget` or that workspace determines where work runs.
Remote paths go through Emacs's existing Remote placement APIs.

Markdown files are authoritative for their content. `.agent/state.sqlite`
contains durable Sessions, Runs, permissions and research records;
`.agent/objects` stores immutable context, Handoffs and artifacts. Retrieval
indexes and caches are projections. Hy Memory retains its existing private
backend and project isolation; its conversation recollections are distinct
from evidence-backed, reviewed Findings.

## Working with Agents

The main Agent manages the goal, context, delegation, integration and delivery.
Subagents receive bounded tasks, relevant references and verifiable completion
conditions. Persistent handoffs point at actual documents and outputs.
`project-agent-management` records this workflow without requiring a special
file format or an available Noema service.

The existing runtime keeps Session identity, ACP execution, bounded parallel
Runs, leases, permissions, context budgeting, deterministic excerpts, frozen
RunSpecs, receipts, memory recall and artifact evidence. Existing `.prompt`
execution remains available through `noema-agent-worker-run-prompt-file`;
legacy work-cell services remain callable by explicit clients. A guidance
Skill does not claim that an ordinary chat acquired those runtime guarantees.

Useful Emacs entry points include the shared Agent Manager, `noema-sessions`,
`noema-project-overview`, `noema-history-search`, `noema-findings` and
`noema-capability-manager`. The shared implementations live in the Emacs
configuration's `lisp/tools/agent/`; Noema supplies project associations and
knowledge adapters.

## Markdown review

Select source in the hosted Markdown editor and send it to an Agent using the
existing context bridge. Requested revisions can return as in-place `ediff`
blocks. Compare rendered fragments or source lines, accept or reject, and send
saved comments back through the same session-selection path. The document
remains the source of truth, and accepting a text edit does not invent a
research verification result.

## Skill packs

- `noema-project`: project Agent coordination, context, memory, handoffs and
  overlapping Runs.
- `noema-emacs`: existing Emacs/Noema commands and supported project APIs.
- `noema-md`: Markdown source syntax and in-place review.
- `emacs-noema-dev`: maintenance of the Emacs configuration and Noema code.

Packs list flat Skill ids. They do not duplicate Skill content, select a new
model or grant execution permissions. Detailed definitions and selection live
in `../../docs/noema/design/capabilities.md` and the scoped capability config.

## Retained research data and services

Existing `.noema` and `.noema.ipynb` files are preserved as legacy JSON work
documents. Their model, validators, graph operations, RunSpecs, events,
Proposals, Findings and CAS evidence remain in the existing services.

The `.noema`-specific JuText editor, directive Company/CAPF, Flymake, Graph
Board, settings/template surfaces and Work Output adaptations are removed.
Visiting a legacy file does not initialize a project, start an Agent/kernel or
open a dedicated output page. Jupyter rejects these work documents, including
its output snapshot endpoints. Their persisted data is not deleted.

The former editor consumer for `worknode.state` is absent. Such a coordinator
request remains recorded and is acknowledged as not applied; the kernel does
not become a replacement document writer. Project Session operations and Run
execution/cancellation retain their own paths.

The vault's `.noema/` index directory is separate from the `.noema` extension
and is retained with the existing Wiki infrastructure.

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

## Publishing reader

The repository still contains a read-only server renderer for publishing Markdown. It is an output/publication surface, not a Noema control UI: authoring, Jupyter, permissions, agents, Proposals and Run control are denied. Server mode also exposes the published notes as an unauthenticated, read-only Streamable HTTP MCP endpoint at `/mcp`; it uses the same public catalog as the reader. See `server-config/`, `../../docs/noema/design/mcp.md` and `../../docs/noema/design/wiki-workspace.md` for that separately scoped service.

## Development map

- `pages/` and `src/cm6/`: hosted Markdown and knowledge surfaces.
- `pages/jupyter-main.ts`, `src/jupyter-rendermime.ts`: ordinary Jupyter output,
  including widgets, math and incremental updates.
- `server/lib/research-runtime.mjs`: existing Run preparation and persistence.
- `server/lib/research-notebook.mjs`, `lisp/noema-research.el`: retained legacy
  work-document model and validation, without the dedicated editor.
- `kernel/noema/research/`: project records, research indexes, events and CAS.
- `server/lib/noema-capabilities.mjs`: capability discovery, scopes and packs.
- `lisp/noema-api.el`, `lisp/noema-capability-ui.el`: project/capability APIs
  and management.
- `lisp/noema-agent-*.el`, `lisp/noema-sessions.el`: project runtime adapters.
- `lisp/noema-research-inspector.el`, `lisp/noema-research-synthesis.el`:
  retained Attention, evidence review and memory Proposal support.

Current architecture and maintenance rules live in `../../docs/noema/`,
`AGENTS.md`, `CLAUDE.md` and `UPSTREAMS.md`.

## License

AGPL-3.0-only. The source-editor infrastructure includes attributed adaptations from Overleaf; see `NOTICE` and `../../docs/noema/records/audits/overleaf-source-editor-study-2026-07.md`.
