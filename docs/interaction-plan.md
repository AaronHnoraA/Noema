# Noema composition and writing plan

## Goal

Offer strong writing and lightweight model interaction in any Emacs buffer
without building another frontend or LLM client.

## Implementation rule

Directly reuse internalized gptel for composition, context, presets, transient
configuration and rewrite/diff review. Noema only supplies stable product entry
points and connects selected work to its Project/WorkNode context.

Agentic work uses internalized agent-shell + acp.el; Magent supplies its local
agent, queue, ledger and gptel integration. These surfaces share Noema project
context but do not collapse compose buffers, AgentSessions and WorkNodes into
one object.

## Current entry points

1. `noema-compose` opens the gptel composition surface.
2. `noema-compose-send` sends from the current buffer.
3. `noema-compose-add-context` uses gptel's context system.
4. `noema-compose-menu` exposes the complete gptel transient.
5. `noema-compose-rewrite` opens gptel rewrite/diff review.
6. `noema-agent-start` opens a structured Magent/Codex/Claude/OpenCode/Pi
   session through agent-shell.

Editable Noema profiles and prompt templates remain under `etc/noema/`.
Future improvements should compose these mature implementations rather than
forking or imitating them.

