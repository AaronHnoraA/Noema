---
name: noema-work-dag
description: Keep a Noema work DAG honest while building: declare the intended work before writing code, advance the WorkNode you own as you go, mark done only with evidence, and mark regressed before repairing something you broke. Use when a Noema Run gives you a `runId` and a `workNodeId` and the task is large enough that its structure matters.
---

# Noema work DAG

The DAG is a ledger, not a judge. The tools refuse structural corruption; *when*
to declare, start or finish work is your discipline. A DAG that shows a broken
foundation under work in progress is doing its job — that is the most useful
status report there is.

Work grows upward: a block of work can only stand on the work below it. Do not
report progress as a flat checklist; `todo_write` is for a session's scratch
list, not for what the project knows.

## Before building

Declare the intended shape first, while it is still cheap to reject.

Submit one `proposal.create` per planned block, `kind: "cell.create"`, each
naming its `lineageParent`. They appear on the person's Graph Board as dashed
ghost nodes. Then stop and let them respond. Do not start building a design
nobody has agreed to.

```json
{ "root": "/abs/project", "runId": "<your run>", "workNodeId": "<your node>",
  "clientRequestId": "plan-3-parser",
  "kind": "cell.create",
  "payload": { "cell": { "notebookId": "<nb>", "cellId": "<stable-id>",
                         "kind": "work", "title": "Parse the fence grammar",
                         "lineageParent": "<parent work node>" } } }
```

Blocks of one plan may name each other: a `lineageParent` or a `depends`
entry can be the `cellId` of another block in the same plan, declared in any
order. The board draws the plan with its own shape rather than as a row of
loose ghosts, which is the point of declaring it up front.

Skip this only for work small enough to finish in one step.

## While building

Work bottom-up. Finish what a block rests on before the block itself. Siblings
that rest on the same work can go in any order. If you must build above
something unfinished, say so in the conversation and say why.

Report your own node as you move, with `research_state`:

| State | When |
|---|---|
| `active` | you have started this work |
| `waiting` | you are blocked on something outside this Run |
| `done` | verification actually passed — see below |
| `regressed` | work that was finished is now broken |
| `dropped` | this approach is abandoned; say why in `reason` |

```json
{ "root": "/abs/project", "runId": "<your run>", "workNodeId": "<your node>",
  "state": "done", "reason": "go test ./noema/research: ok, 41 tests" }
```

`research_state` moves the WorkNode your Run owns and nothing else. It records
the report; the editor applies it. Read the node back with `research_cell` if
you need to confirm it landed.

## No evidence, no done

Mark `done` only when verification actually passed, and put what passed in
`reason` — the command and its result, not a claim that it should work.
`reason` is free text; when the evidence is a file or a command transcript
worth keeping, import it with `artifact` first and name the artifact.

Unverified work is `active`. Work you believe is correct but have not run is
`active`. "It compiles" is evidence for compiling, not for behaving.

## Regression comes before repair

When you break work that was finished:

1. Mark it `regressed` **first**, with what broke in `reason`.
2. Then fix it.

Marking a node `regressed` carries that to every `done` node below it in the
combined work DAG — lineage and `depends` alike. Those nodes are not wrong,
they are unverified again: a finished claim resting on a broken foundation has
to be re-made, not inherited. Re-verify each one and mark it `done` again with
fresh evidence, or explain in the conversation why it was unaffected.

Never repair quietly and leave the DAG green. A green DAG that is wrong is
worse than a red one that is right.

## Reading the DAG

- `research_cell {action: "read"}` — one cell
- `research_cell {action: "neighbors"}` — its explicit lineage and dependency
  neighbours, which is how you find what rests on what
- `research_run {action: "list" | "get" | "output"}` — what has already run
- `artifact {action: "search" | "read"}` — the evidence behind earlier claims

Read the neighbours before declaring new work. Attaching a block to the wrong
parent is the one mistake the tools cannot catch for you: they refuse cycles,
they do not know your intent.

## What the tools refuse

Cycles across lineage and `depends`; a state a WorkNode cannot hold; reporting
on a node your Run does not own; editing the document directly. Everything
else is yours to get right.
