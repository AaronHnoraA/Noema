# Noema interaction migration

## Current state

The former `ai-workbench-*` implementation has been migrated into Noema. The
old directory, features, commands, variables and load paths are not a runtime
compatibility layer.

Current source layout:

```text
site-lisp/noema/
├── lisp/       # Noema-owned commands and domain adapters
├── upstream/   # complete internalized upstream implementations
├── test/elisp/ # migrated interaction tests
└── ...         # Markdown/Wiki/Graph/Jupyter/Go/Node Noema source
```

The useful legacy profile, prompt, context-reference, CLI fallback, result and
session behavior now uses the `noema-interaction-*` namespace. Editable
profiles and templates live under `etc/noema/`; runtime files live under
`var/noema/`.

## Active architecture

```text
gptel UI
  compose · arbitrary-buffer send · context · transient · rewrite/diff

agent-shell + acp.el
  structured agent process · session · stream · permission/input

Magent
  local agent · queue · ledger · gptel adapter · CLI fallback support

Noema
  Project · WorkNode/DAG · Run · Artifact · Emacs workspace integration
```

Noema directly reuses the complete internalized implementations. It does not
maintain a renamed gptel fork or a simplified replacement. Research/runtime
access to agent-shell/acp is centralized in `lisp/noema-agent-acp.el`.

## Public entry points

- `M-x noema` / `C-c A W`
- `M-x noema-agent-start` / `C-c A a`
- `M-x noema-compose` / `C-c A c`
- `C-c A s`, `C-c A m`, `C-c A .`, `C-c A r`
- `C-c A p` to promote the current agent-shell session into Noema research
- `C-c A i r/b/f` for the migrated region/buffer/file interaction helpers

## Required gates

- `make research-test` from AaronEmacs runs both research and migrated
  interaction ERT suites.
- Upstream library resolution must remain below `site-lisp/noema/upstream/`.
- `locate-library` must not find an active `ai-workbench` feature.
- CM6 Markdown, Wiki/Graph, Agenda/Config and Jupyter output remain intact as
  Emacs-hosted Web surfaces.
