# Research synthesis and Proposals

Phase F keeps model output outside authoritative research state until a human
reviews it. Magent and the future Pi supervisor submit the same typed Proposal
envelope; neither adapter can create a Finding, Research IR version, Problem
Model version, Task, or notebook cell directly.

## Emacs workflow

In a saved JuText research notebook, run
`M-x noema-research-propose-with-magent` (bound to `C-c C-r`). Magent performs
one gptel sample with provider tools disabled. The selected region, or the
current cell body, is enclosed as untrusted research data and the response must
be one bare JSON object. A selection or current cell marked `local_only` is
rejected before the sampler is called.

Pending `cell.create` Proposals appear as dashed diamond nodes in Graph Board.
They are not editable notebook cells. Open Attention with `a` in Graph Board or
`C-c C-a` in JuText to accept or reject a Proposal. The authenticated research
control page presents the same versioned actions.

A cell acceptance uses three durable states:

1. `pending`: no notebook write has happened;
2. `accepting`: the reviewed payload and reviewer are reserved before the
   notebook compare-and-swap write;
3. `accepted`: the reindexed cell identity, content, lineage, dependencies and
   source hash match the frozen reviewed payload.

An interrupted `accepting` Proposal remains in Attention as “Resume
acceptance”. Replaying the same reservation and reconciling an exact existing
cell are idempotent. A concurrent rejection cannot cross the reservation.

## Pi supervisor hook

`aaronnote:api:research:supervisor:propose` is a narrow JSON ingress. It forces
`proposedBy=agent:pi:supervisor` and `sourceAdapter=pi-supervisor-hook`, rejects
review/decision fields, and calls only Proposal creation. It is a transport
hook, not a claim that a real Pi supervisor RPC exists. The locally installed
`pi-acp` remains an ordinary ACP execution adapter until a supported supervisor
transport is installed and validated.

## Workstream export

`aaronnote:api:research:export:create` creates a bounded,
content-addressed `application/vnd.noema.workstream+json` artifact. The package
contains notebooks, runtime records, Proposals, Findings, immutable Research IR
and Problem Model versions, Tasks, Jobs, immutable Invocations/results, Worker
profiles, Delegations, redacted Worker leases, events, and the referenced CAS
closure. Lease tokens are never exported.

The default `includeLocalOnly=false` export removes `local_only` cells,
Findings, Proposals and Tasks, follows Task dependency/descendant closure, and
omits Jobs, Invocations and Delegations underneath excluded Tasks. It also
omits IR/Problem Model versions that could retain filtered Finding references
and records every omission in the disclosure manifest.
Including local-only data must be explicit. The returned artifact can be read
through the existing artifact endpoint or `artifact(read)` MCP tool.

Unit and integration tests establish the state-machine, hash, disclosure and
round-trip contracts. They do not replace the large provenance/scale/model
benchmarks or real Pi/manual UI validation listed in the Phase F review.
