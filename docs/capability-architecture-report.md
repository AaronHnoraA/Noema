# Semantic API and capability architecture report

## Repository audit

Before this change Noema already had strong reusable boundaries:

- `noema-research.el` was a pure semantic WorkDocument/WorkNode/DAG model;
- `noema-research-mode.el` supplied validated, undoable structural operations;
- `research-directives.mjs` strictly parsed the documented leading
  `@@agent`, `@@session`, `@@ctx`, and `@@skill` region;
- `research-runtime.mjs` resolved context and froze immutable RunSpecs;
- the Go research store owned Runs, events, sessions, artifacts and CAS;
- `noema-agent-acp.el` and `noema-agent-worker.el` formed the ACP execution
  boundary;
- JuText and Graph Board were already projections of the same model.

Skill handling was only a private project-directory lookup inside Run
preparation. It could freeze `.agents/skills/<id>/SKILL.md`, but had no shared
scope model, patching, availability inspection, project selection API or UI.
MCP construction separately injected the one live Noema URL. The Emacs worker
assumed every frozen MCP was HTTP. Existing UI commands called private
structural/run functions directly.

The repository contained no implemented `company` scope or MCP/project patch
syntax, and the design explicitly limited `.noema` to its four directives. The
implementation therefore keeps that language unchanged and uses an explicit
project JSON configuration for persistent capability state.

## Implemented boundary

The architecture is now:

```text
.noema / noema-capabilities.json / Skill directories
                         |
                         v
             Node capability resolver
              |                    |
              v                    v
       public Emacs API       frozen RunSpec
          |       |            |          |
       JuText   manager      Skill bytes  MCP configs
          |       |            \          /
          +-------+             ACP worker
```

`noema-capabilities.mjs` owns discovery, identity, precedence, patching,
selection, validation and provenance for both domains, while retaining
domain-specific Skill and MCP representations. It exposes pure resolution and
explicit project mutations. `research-runtime.mjs` consumes that resolver; no
agent-specific filesystem scan remains.

`noema-api.el` exposes project/context, DAG queries, structural mutations,
Run effects and async capability operations. JuText execution and relationship
editing plus Graph Board creation/state/execution now consume it. The
tabulated-list manager also consumes it.

## Resolution and patch invariants

- scope order is explicit and returned in every resolution;
- the highest definition is the base, while shadowed sources remain visible;
- only patches at or narrower than that winning base are applied;
- patches use JSON Merge Patch, plus Skill `content_append`;
- selection is deterministic and its reasons are retained in `selectedBy`;
- an explicit disable cannot be bypassed by `@@skill`;
- definition/configuration, effective value and runtime state are separate;
- RunSpec freezes only active capabilities and their provenance;
- the UI is a projection and never reconstructs resolution.

See [capabilities.md](capabilities.md) for the precise file format and
[noema-elisp-api.md](noema-elisp-api.md) for the public functions.

## Migrated flows

- JuText `C-c C-c` -> `noema-run-cell`;
- Graph Board default/continue/fork/fresh execution -> `noema-run-cell`;
- JuText project `.py`/`.ipynb` execution -> `noema-run-project-file`;
- Graph Board downstream/sibling/checkpoint/root creation ->
  `noema-create-node`;
- JuText relation add/remove -> `noema-link` / `noema-unlink`;
- JuText and Graph Board state changes -> `noema-set-node-state`;
- Skill completion -> ids from the last authoritative resolution;
- agent startup -> resolver-frozen Skill context and stdio/HTTP/SSE MCP list;
- capability manager actions -> public query/mutation API.

Private `noema-research-op-*` functions remain as the tested structural backend
until every legacy caller is migrated. Wire channels retain their historical
`aaronnote:api:*` prefix for compatibility.

## Demonstrated scenario

The automated acceptance path constructs real temporary Noema projects and
executes the actual parser, resolver and RunSpec builder. Its integrated
RunSpec scenario is:

1. an explicit `company` shared configuration defines `project-method`;
2. that shared scope augments the Skill with its own patch;
3. project configuration enables it and applies a narrower patch;
4. the work block selects it with `@@skill(project-method)`;
5. project configuration defines and enables a stdio MCP;
6. resolution returns the company base plus company/project patch provenance;
7. Run preparation freezes patched Skill bytes, content hash, configuration,
   active provenance and both built-in HTTP/project stdio MCP definitions;
8. the Emacs manager test renders that authoritative shape and verifies its
   disable action calls the public mutation API;
9. the semantic execution test verifies JuText calls `noema-run-cell`, which
   dispatches the selected Cell id and session policy to the established worker;
10. the worker test verifies the frozen MCP transports reach ACP unchanged;
11. graph query/mutation tests verify stable WorkNode ids, not text positions,
    drive the operation.

Separate resolver coverage also verifies a global Skill patched by both
company and project scopes, including the complete source and patch chain.

The scenario is covered by `tests/noema-capabilities.test.ts`, the
`builds an agent RunSpec from resolved project Skills, MCPs, and patches` test in
`tests/research-runtime.test.ts`, and `test/elisp/noema-api-tests.el`.

For a live manual pass, open a project `.noema`, run
`M-x noema-capability-manager`, enable `noema-elisp-api`, add
`@@skill(noema-elisp-api)` to a work block, then use `C-c C-c`. Inspecting the
prepared Run shows `skills`, `mcp_servers`, and the active-only
`capability_environment`; the agent receives the frozen Skill content and can
evaluate the documented semantic calls in Emacs.

## Tests and remaining debt

Coverage includes discovery, multi-scope precedence, replacement provenance,
patch application, enable/disable, conflict/error behavior, MCP transport and
runtime-state separation, RunSpec integration, semantic query/mutation/effect
dispatch, and UI-to-API delegation. Existing directive and `.noema` round-trip
tests continue to cover syntax preservation.

Remaining work is deliberately bounded:

- external MCP health is currently `not-observed`; a future runtime observer
  can populate it without changing persistent configuration;
- there is no implicit organization service or remote capability installer;
  shared scopes are explicit files until the product defines those semantics;
- some low-value legacy UI callers still reach `noema-research-op-*` directly;
- capability mutations are project-level; editing shared/global files remains
  an administrator/file-management operation;
- a future permission model may classify API effects more formally, but this
  change documents the query/mutation/runtime distinction without inventing a
  second authorization system.
