# Noema + internalized Magent runtime

Noema reuses Magent as one runtime participant rather than treating Magent's
session store as the Noema project model.

| Path | Sampling/execution | Immediate owner | Noema relation |
|---|---|---|---|
| Magent agent | Magent + gptel through ACP | Magent/agent-shell | lightweight semantic work and proposals |
| External ACP agent | agent-shell + acp.el | external agent | structured Session/Run execution |
| CLI fallback | native JSON stream adapter | native CLI + Magent queue | fallback when the ACP capability is absent |

Magent supplies the local agent, single-execution queue, ledger/event replay,
gptel adapter and its complete supporting implementation. Noema supplies the
durable Project, WorkNode, Run, Permission and Artifact association.

Runtime constraints from the migrated implementation remain active: bounded
JSON lines/prompts/answers/diagnostics, bounded transcript buffers,
incremental streaming, cancellable request handles and project-scoped session
identity. Configurable values are registered in `lisp/init-ai-ide.el` and
persisted through `etc/config-store.el`; state lives below `var/noema/`.

All research-worker calls into agent-shell/acp go through
`lisp/noema-agent-acp.el`. The full Magent source lives in
`upstream/magent/`; provenance is recorded in `UPSTREAMS.md`.

