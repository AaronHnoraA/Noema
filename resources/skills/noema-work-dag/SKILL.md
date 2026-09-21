---
name: noema-work-dag
description: Work in a Noema project's work DAG — declare the intended work before building, report the WorkNode you own, and keep the record honest about what has actually been verified. Use when a Noema Run gives you a `runId` and a `workNodeId`.
---

# Noema work DAG

The DAG is a ledger, not a judge. Noema refuses structural corruption and
*notices* unsupported claims, but **when** to declare, start or finish work is
your judgement. A DAG showing a broken foundation under work in progress is
doing its job.

Work grows upward: a block can only stand on the work below it. `todo_write`
is a scratch list for one session; it is not what the project knows.

## What the system already does

You do not have to remember these; they happen whether or not you do.

- **Regression travels.** Marking a node `regressed` carries it to every
  `done` node resting on it, across lineage and `depends` alike. You do not
  walk the graph yourself.
- **Unsupported claims are flagged.** A node marked `done` with no Run and no
  outcome, a node whose last Run failed, a `done` node above a `regressed`
  one, an `active` node with no Run — each raises a warning the person sees.
  Warnings never block an edit; they make a lapse visible.
- **Staleness is answerable.** `research_cell {action: "changes"}` reports
  which files a node's Runs touched have moved since. It only reports.
- **Reports are confirmable.** `research_state` records; the editor applies.
  `research_state {action: "status", requestId}` tells you which of those has
  actually happened. Do not assume a report landed.
- **The preview says what you are resting on.** Unfinished or regressed
  dependencies, and re-running something already `done`, appear in the run
  preview. None of it blocks the Run.

## What remains yours

**Declare before building.** Submit the plan as one `proposal.create`,
`kind: "graph.declare"` — blocks may reference each other by id, and the whole
plan is accepted or rejected together. Then stop and let the person respond.
Do not build a design nobody has agreed to. `cell.create` adds a single block
to work already agreed.

**Attach work to the right parent.** This is the one mistake the tools cannot
catch: they refuse cycles, not bad judgement. Read
`research_cell {action: "neighbors"}` before declaring.

**Say what you verified, not that you verified.** Put the command and its
result in `reason` — `go test ./...: ok, 41 tests`, not "tests pass". Import
what you checked with `artifact {action: "import"}` when it is worth keeping.
Unverified work is `active`; "it compiles" is evidence for compiling.

**Mark `regressed` before you repair.** Record what broke first, then fix it.
Afterwards restore each affected node only as its own verification passes
again — one at a time, not in a sweep. Re-greening a node you have not re-run
is the lie the whole ledger exists to prevent.

**Work bottom-up.** Finish what a block rests on first. Siblings on the same
footing can go in any order. If you deliberately build above something
unfinished, say why in the conversation — the preview will have told you.

## Boundaries

`research_state` moves the WorkNode your Run owns and nothing else. Structure
changes are Proposals. Nothing here edits a `.noema` document directly, and
the knowledge base — notes, search, tags — is a different surface on a
different endpoint.
