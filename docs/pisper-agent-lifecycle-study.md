# Pisper study for Noema: agent management and interaction

Reviewed 2026-09-28:

- <https://github.com/ling-kong-ran/pisper> at `c40db63214ec66b65e12e4a3b6da15e7fe7f53f9`
  (MIT). Adapted code carries an attribution comment; no file was copied.
- Every source file was triaged: 199 Runtime modules (`runtime/`), 224 UI,
  TUI and shared modules (`src/`, `src-tui/`, `shared/`), plus the build,
  mobile and release scripts. Agent management was read in full:
  `runtime/runtime/session-*.mjs`, `stream-retry.mjs`, `compaction-policy.mjs`,
  `multi-agent-runtime-adapter.mjs`, and `runtime/services/{multi-agent-service,
  team-workflow,goal-service,plan-service,session-permission-service,
  session-file-changes,side-chat-service,run-registry,chat-session-organization}.mjs`,
  with its decision records in `docs/architecture/` and
  `docs/team-mode-playbook.md`.

## Scope and verdict

Pisper is a multi-agent workbench (Tauri, TUI, mobile) on Pi Coding Agent. Its
product object is the *session*; Noema's is the work genealogy (D-023), and
Emacs stays the only UI. The overlap is what Noema must also run: several live
agents, their lifecycle, and a person keeping track of them.

Noema was already stronger underneath — durable SQLite events with an `after`
cursor, CAS-frozen RunSpecs with leases, named sessions with native and
reconstructed forks, a Pi manager without approval power. Pisper was ahead in
the operator's experience: seeing what needs you, working in parallel, and
knowing why something failed. That is what was adopted.

## Implemented

| # | From Pisper | In Noema | Where |
|---|---|---|---|
| 1 | Session organization: `unread`, `failed`, `needsAttention` (`session-organization.md`) | Kernel projection from the latest Run plus `read_at`; `session:name:read`; Attn column, attention-first order, `u`, `!` | `session_names.go`, `noema-sessions.el` |
| 2 | Transient-error classification (`stream-retry.mjs`, team error kinds) | `failureKind`/`retryable` on every failed Run; Last Run column; no automatic retry | `run_failure.go` |
| 3 | Bounded agent slots (`MultiAgentService`, 4 slots, FIFO) | RunSpec freezing stays serial, execution runs in parallel up to `noema-agent-worker-max-concurrent-runs` (3); `⋯n` waiting in the mode line | `noema-agent-worker.el` |
| 4 | Team file ownership enforced at authorization | Concurrent edit of a path another open Run may edit waits for a person, with `policyReason` shown as `why:` in Attention | `permission_policy.go`, `noema-research-inspector.el` |
| 5 | Temporary side chat (`side-chat.md`) | `s` / `C-c C-q`: same agent and directory, no history, never durable, auto-stopped when idle and hidden; one per session | `noema-sessions.el`, `noema-agent-acp.el` |
| 6 | Resident-runtime protection (`sessionRuntimeIsProtected`) | Queued agent-shell prompts protect a session from automatic stops | `noema-agent-acp.el` |
| 7 | Approval card diff preview (`file-change-preview.mjs`) | `+N -M` and a `diff` button per proposed file change, kept locally, never hashed into the action | `noema-agent-worker.el`, `noema-research-inspector.el` |
| 8 | Idle time on active agents (multi-agent `list`) | `running, idle 45s` after `noema-sessions-idle-threshold` | `noema-sessions.el` |
| 9 | Retry beside the latest error | `R` reruns the failed work block; asks first when not retryable | `noema-sessions.el` |
| 10 | Completion / awaiting-confirmation notifications | System notification when Emacs is unfocused: decision needed, Run ended (cancel excluded) | `noema-agent-worker.el` |
| 11 | Secret redaction (`secret-redaction.mjs`) | `RedactSecrets` on stored failure reasons and the history index; originals untouched | `redact.go` |
| 12 | Team-mode playbook | Built-in Skill `noema-parallel-runs` | `resources/skills/` |

Invariants these introduce are listed in `AGENTS.md` under "Agent lifecycle
and attention".

## Already present — not adopted

- **Steer / follow-up input queue** (`session-input-queue.mjs`): agent-shell
  0.79 has queueing, steering, per-item removal and a steering capability
  check. Noema reads the queue length only.
- **Run event replay** (`run-registry.mjs`, 10-minute ring buffer): Noema's
  kernel event log is durable and cursor-addressed.
- **Crash → interrupted** (`MultiAgentService.init`): Noema's lease expiry.
- **Session branching from a completed turn** (`deriveSession`): D-031 fork,
  native or reconstructed.
- **Turn-boundary compaction** (`compaction-policy.mjs`): ACP agents compact
  themselves; Noema rolls over to a Handoff at a Run boundary.
- **Approval memory** (5-minute cache keyed by command): Noema's
  `PermissionRule`s are durable and narrower (exact paths, argv prefix).
- **Goal completion audit** (`goalContinuationPrompt`): the `noema-work-dag`
  Skill already demands stated evidence before `done`.
- **Honest change counts** (`session-file-changes.mjs`, `known|partial|
  unavailable`): `SourceChanges` reports from content digests and never
  decides; no per-session count is shown that could be wrong.
- **Session tree labels**: WorkNodes and checkpoints are Noema's anchors;
  `noema-history-search` indexes transcripts.
- **Command guard** (`command-guard.mjs`): Noema's hard denials plus
  "leaves the project → a person decides" cover it.

## Rejected, with reasons

- **Auto-waking the parent with child results** (mailbox + completion
  notifier): agents driving agents. Noema's execution is started by a person
  and Pi has no execution authority (D-032, D-035).
- **Goal / Team continuation loops with token budgets**: an agent continuing
  on its own conflicts with explicit Runs and review checkpoints. Revisit
  only as a decision record.
- **Scheduled prompts and the visual workflow engine** (`schedule-service`,
  `workflow-service`): same reason; Noema's DAG records structure and is not
  a scheduler.
- **Decision models with probability-based auto-approval**: Noema's policy is
  deterministic; no model approves.
- **Tool gateway / discover-tools activation**: ACP agents own their tools;
  Noema already splits its MCP surfaces.
- **Long-term memory runtime** (propose → accept, local embeddings): Noema's
  knowledge base and evidence-backed Findings fill that role.
- **Provider discovery, keyring, model catalogues, prompt-cache diagnostics,
  gateway model-ref recovery**: agents own authentication and models.
- **IM channels (Feishu, WeChat, QQ, Telegram), remote pairing, mDNS, Iroh,
  mobile runtime**: no cloud or second product shell; the Remote framework
  covers remote execution.
- **Web/TUI UI** (dock split view, composer toolbar, virtualised transcript,
  paste-burst detection, slash-usage ranking, workspace ordering, layout
  editor): Emacs windows, completion and tabulated lists do this natively.
- **Speech, visual generation, game assets, sprites, desktop pet, custom UI,
  OCR, computer use, browser automation**: outside Noema's scope.
- **Build, release, SEA and mobile scripts**: platform-specific.

## Review triggers

Revisit when Noema needs more than one side chat per session, per-project
slot limits, declared write scopes on WorkNodes, or delegation that another
agent may start without a person.
