# Noema interaction upstream provenance

This document records the transition from the earlier interaction prototype.
The current authoritative inventory is [UPSTREAMS.md](UPSTREAMS.md).

The initial prototype embedded Magent and carried separate Claude/Codex
compatibility code. D-022 completed that direction by moving the whole
interaction layer under Noema and internalizing complete, traceable source
trees for gptel, agent-shell, acp.el, shell-maker and Magent.

Noema-specific integration remains intentionally bounded:

1. `lisp/noema-compose.el` exposes the mature gptel UI directly.
2. `lisp/noema-agent-acp.el` is the sole research/runtime boundary to
   agent-shell and acp.el.
3. `lisp/noema-interaction-magent*.el` retains the audited queue/CLI fallback
   integration from the prototype under Noema naming.
4. Upstream source retains original feature names, licenses, docs and tests.
5. Noema owns Project/WorkNode/Run/Artifact semantics; upstream buffers and
   sessions do not become the durable work model.

Before refreshing an upstream tree, compare the recorded revision, preserve
license/provenance, reapply only explicit integration deltas, and run Noema
research, interaction, Jupyter and renderer tests.

