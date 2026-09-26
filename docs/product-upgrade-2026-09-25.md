# Noema product logic and 2026-09-25 upgrade

The product is an Emacs-owned, local-first research workspace. Its advantage is not another chat box: it keeps the research question, work graph, agent activity, evidence and written conclusion connected without replacing the underlying files or the person's scientific judgment. The knowledge vault remains Markdown, `.noema` remains the canonical AI work document, and Node/Go provide headless execution, indexing and durable records. The UI is Emacs; the web-rendered components are hosted inside it.

## Object and workflow model

| Product question | Authority | Human surface |
| --- | --- | --- |
| What are we trying to establish? | `.noema` Question/WorkNode graph | JuText + Graph Board |
| What must be done next? | WorkNode state and Task/Job store | Project overview + Work queue |
| Which agent and conversation can be reused? | Session registry and ACP native session | Sessions / Agent window / project overview |
| What instructions and tools does the agent receive? | Resolved Skill/MCP configuration and frozen RunSpec | Capability manager + context preview |
| What did the agent actually do? | Runs, immutable artifacts and source-change checks | Run output + Inspector |
| Which claims are supported? | Reviewed Finding with exact artifact spans and verification level | Attention + Findings board |
| Where did an earlier attempt go? | Read-only native-history FTS5 index | History search |

The primary journey is **literature → design or proof plan → experiment or derivation → evidence synthesis → manuscript**. Each template is a complete graph written once after a human preview. Work stages may use reusable Skills; review checkpoints remain explicit. An Agent Run cannot skip an unfinished template stage through the public Emacs Run command. Agents cannot accept their own structural or Finding Proposals: existing review and revision-fenced materialization remain authoritative. The checkpoint marker is an undoable local document review cue, not a cryptographic or external authorization system.

## What changed

- A single project entry point joins previously separate Sessions, Skills/MCP, orchestration, Attention, Findings, native history and workflow creation. It resolves current objects instead of duplicating their databases.
- Skill frontmatter now uses YAML semantics and honors `noema.requires`. A selected Skill pulls in its dependencies; missing, disabled, invalid or cyclic dependencies stop Run preparation. The new experiment/proof Skills complete the two research routes.
- Findings are browsable as evidence-backed claims, not flattened into chat prose. Native agent histories are searchable by project and source, with bounded previews and explicit full reads.
- Asynchronous Emacs views reject stale callbacks and keep same-named projects separate. New ERT tests cover project scoping, session identity, template validation, human review edits and Run gating.
- The corpus benchmark now uses the current `.noema` v2 document rather than a retired `.ipynb`-shaped fixture. Synthetic 1k/10k/100k scale checks exercise incremental indexing, FTS, exact block reads and accepted Findings.

## Intentional boundaries and remaining acceptance

Noema does not silently execute the whole research pipeline, certify a proof, invent citations, or submit a manuscript. Real models, source quality, ethics, venue policy and scientific conclusions need separate human validation. Agent filesystem isolation remains governed by the existing execution-target and permission mechanisms; this upgrade did not invent an unverified worktree sandbox. The benchmark numbers are local synthetic measurements, not a promise about production workloads. A real Emacs GUI walk-through and real-agent literature-to-paper exercise remain the acceptance steps before calling this workflow field-tested.
