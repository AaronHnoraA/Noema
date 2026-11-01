---
name: noema-parallel-runs
description: "Coordinate overlapping Noema Agent Runs in one project workspace: define write ownership, preserve other edits, handle contested paths and report verifiable results. Use when project Runs share files; it does not require a .noema work document."
---

# Parallel Runs in one workspace

Noema executes several Runs at once (`noema-agent-worker-max-concurrent-runs`,
3 by default). They share the project's workspace but never a named session.
Adapted from Pisper's team-mode playbook, whose every rule came from a real
failure: a stuck agent spinning for 45 minutes, an interrupted refactor that
left a broken tree, reverts that destroyed another agent's work.

## What the system already does

- **Contested files wait for a person.** When you edit a path another open
  Run was already allowed to edit, the request is not auto-approved; it waits
  in Attention with the reason. That is not a failure. Do other work or say
  what you need, and let the person decide.
- **A named session serves one Run.** A Run for a busy session waits for it.
- **Failures are classified.** A rate limit, dropped connection or lost lease
  is marked retryable; authentication, quota and context failures are not.
  Do not retry the non-retryable ones yourself — report them.

## What remains yours

**Keep to your assigned files.** Before editing, name the task's write scope.
Read the necessary shared inputs; coordinate a scope change with the managing
Agent when another task owns the destination. A multi-file restructuring is one unit:
do all of it or none of it, never leave an import pointing at a file you
have not created yet.

**Never undo what you did not do.** Other Runs, and the person, change files
while you work. Do not `git checkout`, `git restore`, reformat or rewrite a
file back to `HEAD` to get a clean slate. Note the state you started from;
repair only your own changes, and if you cannot tell whose a change is,
leave it and say so.

**Verify narrowly, stop early.** Run the tests for what you touched, not the
whole suite on every change — other Runs are competing for the same machine.
If the same command fails twice with no progress, stop and report; do not
try a third variation, and do not escalate to a full build to see what
happens.

**Report so the person can act.** End with: the files you changed, the
commands you ran and their results, what is unfinished, and anything you
needed but did not touch. "Tests pass" is not a report; `go test ./x/...: ok`
is. Return results to the managing Agent for integration and verification.

## Boundaries

This Skill is about sharing a workspace. The installed runtime owns leases,
permissions and Session state; these instructions do not simulate those
mechanisms when they are unavailable. For project context and handoffs, use
`project-agent-management` when installed.
