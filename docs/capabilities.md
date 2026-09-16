# Project Skills and MCP capabilities

Noema resolves project capabilities before it freezes a RunSpec. The resolver
is the single authority used by the host API, the Emacs manager, and agent
startup. UI code does not scan Skill directories or merge configuration.

## Sources and precedence

The ordered scopes are:

1. `builtin`: Skills under Noema's `resources/skills/` and the live Noema MCP;
2. explicitly linked native libraries (`external-claude`, `external-codex`,
   `external-opencode`, `external-pi`, etc.), in the global config's `sources` order;
3. `global`: Emacs's `etc/noema/skills/` plus `etc/noema/capabilities.json`;
   the Emacs host supplies the path under `user-emacs-directory`, defaulting
   to `~/.emacs.d/etc/noema/`. Override the config with
   `NOEMA_GLOBAL_CAPABILITIES`; the default Skill library is its sibling
   `skills/` directory (override with `NOEMA_GLOBAL_SKILLS`);
4. each explicitly named shared scope in project `extends`, in listed order;
5. `project`: `.agents/skills/` and `noema-capabilities.json` in the project;
6. a Run's `@@skill(id)` selection.

Emacs completion uses `company-mode` through CAPF; it is unrelated to scope
precedence. A team can optionally name an explicit shared scope `company`;
that name and source then appear in provenance:

```json
{
  "schema": "noema.capabilities/1",
  "extends": [
    { "scope": "company", "path": "shared/company-capabilities.json" }
  ]
}
```

Every definition has a stable id. A Skill's `name` frontmatter is its id, with
the directory name retained as a reference alias. An MCP uses its `id`.

For a given id, the highest-precedence definition is the base. Lower definitions
are retained as `shadowedDefinitions` for inspection; their patches do not leak
into the replacement. Patches and selections at the base scope and all narrower
scopes are then applied in order. This yields exactly one effective record:

```text
winning definition + ordered patches + ordered selection => effective capability
```

Explicit enable/disable at a narrower scope wins. Listing the same id in both
arrays at one scope is a validation error. `@@skill(id)` selects an otherwise
available Skill for that Run, but cannot bypass an explicit disable; preparation
then fails with a `disabled-capability-requested` diagnostic.

## Project configuration

### Linked native libraries

Only the global config may declare native `sources`. These reference local
symlinks and do not rewrite the clients' files. Example:

```json
{
  "schema": "noema.capabilities/1",
  "sources": [
    { "id": "codex", "format": "codex", "config": "linked/codex/config.toml",
      "skills": ["linked/codex/skills", "linked/codex/skills/.system"] },
    { "id": "pi", "format": "pi", "config": "linked/pi/mcp.json",
      "skills": ["linked/pi/skills"] }
  ]
}
```

Supported native MCP sections: Codex TOML `mcp_servers`, OpenCode JSON/JSONC
`mcp`, Claude JSON `mcpServers`, and Pi extensions using the same `mcpServers`
layout. Pi itself need not have an MCP config. Missing paths are optional and
shown as not created yet. Malformed sources get a diagnostic without echoing
parser messages or credentials. Only explicit Skill roots are scanned, one
directory level deep; plugin marketplaces and caches are not recursively
indexed or executed. Add a plugin's actual `skills/` root explicitly.

Imported MCPs are opt-in in Noema even when enabled in their native client.
Native explicit disables remain inspectable and can be overridden at project
scope. Environment and header maps are normalized; environment references are
resolved from the host environment, never by running a shell. Native cwd,
tool allow/deny lists and explicit OAuth configuration are marked incompatible
instead of being silently discarded. OAuth login stores are not imported.

Use `L` in either manager for the linked-source overview. `f` or a source
button opens the original file: saving that file affects its native client
as well. Normal `e`, `d`, `p`, and `E` operate on the active Noema page's scope,
never on the linked native configuration itself.
`G` edits the global Noema library config and `D` browses its Skill directory.
Changes saved through a symlink invalidate the capability cache; `g` refreshes
after changes made outside Emacs. Linking is not bidirectional installation:
new Noema Skills do not automatically appear in each native client's catalog.

### Project-owned definitions

`noema-capabilities.json` is separate from `.noema` because persistent project
capability definitions are not work-cell execution directives. The minimal file
is:

```json
{
  "schema": "noema.capabilities/1",
  "skills": {},
  "mcp": {}
}
```

A fuller example is:

```json
{
  "schema": "noema.capabilities/1",
  "extends": [
    { "scope": "company", "path": "shared/company-capabilities.json" }
  ],
  "skills": {
    "enabled": ["proof-review"],
    "disabled": ["unsafe-experiment"],
    "patches": {
      "proof-review": {
        "configuration": { "strict": true },
        "content_append": "Require an explicit counterexample search."
      }
    }
  },
  "mcp": {
    "servers": [
      {
        "id": "project-tools",
        "command": "/usr/bin/env",
        "args": ["node", "tools.mjs"],
        "env": [{ "name": "MODE", "value": "project" }]
      },
      {
        "id": "remote-search",
        "type": "http",
        "url": "https://example.invalid/mcp",
        "headers": []
      }
    ],
    "enabled": ["project-tools"],
    "patches": {
      "project-tools": {
        "config": { "args": ["node", "patched-tools.mjs"] }
      }
    }
  }
}
```

`skills.directories` may add Skill directories relative to that configuration
file. A Skill remains a directory containing `SKILL.md`; its frontmatter should
contain `name` and `description`.

MCP definitions use ACP's three shapes:

- stdio: `command`, `args`, `env`;
- HTTP: `type: "http"`, `url`, `headers`;
- SSE: `type: "sse"`, `url`, `headers`.

The definition/configuration and observed runtime state are different fields.
Noema can report its supervised built-in MCP as `available` or `unavailable`.
For stdio MCPs it checks whether the configured executable is currently
available; an enabled missing executable blocks Run preparation. External
process/connection state remains `not-observed` until a runtime integration
supplies live health, so project configuration alone never claims it is running
or connected.

## Patch model

Patches are JSON Merge Patch objects applied to the effective definition. A
`null` value removes a field. Skill patches additionally support
`content_append`, which appends instructions without copying `SKILL.md`.

The resolver records every applied patch with `scope`, `scopeId`, `source`, and
the patch value. Reserved identity/provenance fields cannot be patched.
Persistent configuration, the resolved effective value, and transient MCP
runtime state remain distinct.

## Work-cell syntax

Noema preserves the documented four leading directives:

```text
@@agent(codex)
@@session(continue)
@@ctx(lineage)
@@skill(proof-review)

Check the disputed lemma.
```

`@@skill(id)` is parsed only in the leading control region. It becomes a Run
selection, is resolved against the project environment, and is frozen by id,
path, content hash, source scope, effective configuration, and applied patches.
The effective Skill content is a frozen context item, with a small source-path
header so agents can find relative supporting resources. The Skill's source
hash and the delivered context item's wrapper hash are kept distinct. Later `@@skill(...)` text
is prompt data. There is intentionally no new `@@mcp` or patch DSL: MCP selection
and persistent patching belong in `noema-capabilities.json`.

## Diagnostics and inspection

Resolution reports unknown ids, malformed configuration, invalid definitions,
same-scope duplicates, conflicting selections, invalid patches, and a disabled
Skill requested by a Run. Diagnostics include capability id/type and source or
scope where available. An enabled invalid capability prevents Run preparation.

Use `M-x noema-capability-manager` anywhere. It always opens the global library
without a project prompt. `C-c 1` selects Global; `C-c 2` selects Project Patch;
`C-c 3` selects Local Skills (only project-owned definitions). The latter two use
the project captured from the opening buffer and are unavailable outside a
project. Queries and writes on Global never discover or initialize a project;
new Skills go to `etc/noema/skills`, and configuration to `etc/noema/capabilities.json`
(or the explicit host environment overrides). Project pages write only their
project configuration, `.agents/skill-patches` and `.agents/skills`. Project
Patch lists only explicit project overrides/selections, not the inherited library.
Switching pages reuses fresh cached
resolutions; global writes invalidate project caches too. The tabulated buffer
shows availability, effective enabled state, winning source/scope, patch count,
validation, and MCP runtime state. Evil stays enabled in normal state. Use
`C-c C-a` for the action menu, or these prefixed keys (bare motions/operators
retain their Evil meanings):

| Key | Action |
|---|---|
| `RET` / `C-c i` | inspect the full effective value and resolver provenance |
| `C-c e` / `C-c d` | enable or disable at the active page's scope |
| `C-c p` / `C-c P` | create or remove a project patch |
| `C-c y` | independently copy a global Skill and resources to Local |
| `C-c s` | draft an agent-shell micro-refinement request (review before sending) |
| `C-c a` | add a Skill or MCP in the current view |
| `C-c c` | visit the active scope's canonical configuration |
| `C-c g` | re-read files, validate patches and resolve again |

Use `M-x noema-skill-manager` or `M-x noema-mcp-manager` for a filtered view.
In an `agent-shell` buffer — the platform session or a popup vterm one — the
same three commands are a read-only lookup instead, because the manager's
scoped writes reach Noema Runs, not a running external client. `M-x
noema-capability-lookup` is the explicit name. The lookup resolves the same
host capability model (the opening buffer's project, otherwise global), offers
the filtered candidates with state, scope and description, and drafts one line
naming the selected capability's resolved source at the agent's input. It
enables, patches, installs and submits nothing; review the draft and send it
yourself. Skills draft their absolute `SKILL.md` and resource directory, so the
external agent reads the same file Noema would freeze; MCPs draft the
configuration file that owns the server.

The unified manager also supports:

| Key | Action |
|---|---|
| `C-c /` | filter all / Skill / MCP |
| `C-c a` | add in the current view (MCP uses an Emacs form) |
| `C-c n` / `C-c I` | create / import a Skill in the active scope, including supporting resources |
| `C-c f` / `C-c o` | open file / Dired on the right; keep the manager on the left |
| `C-c u` | insert `@@skill(id)` at the start of the work block that opened the manager |
| `C-c E` | edit an MCP as a definition in the active scope |
| `C-c t` | test MCP initialization and list tools in a temporary session |
| `C-c l` | inspect the last test's tools, input schemas, errors and stderr |
| `C-c ?` | mode help |
| `C-c G` / `C-c D` | global configuration / global Skill directory |
| `C-c L` | linked Claude, Codex, OpenCode and Pi sources |

Skill micro-refinements use `skills.patches[id].patch_file` and `base_sha256`.
Only `.agents/skill-patches/<id>/skill.patch` contains the effective delta;
`PATCH-BASE.md` is an immutable reference snapshot, not a full-text override or
Local Skill. Resolution applies a single-document unified diff using the system
`patch` program in an isolated temporary directory (`-t -N -F 0`, no shell).
Source hashes, path containment, hunk structure and frontmatter are validated;
conflicts fail closed. Inputs/results are limited to 1 MiB, execution to 5 seconds,
and successful results to a bounded 16-entry content cache. Completion never
launches patch processes. The explicit Patch action converts legacy `content_file`
overrides to deltas while retaining old Markdown files. MCP patches remain JSON
merge patches. Only Copy to Local creates an independently editable whole Skill.

Skill creation/import preserves existing directories. New Skills are available
for `@@skill` selection; use `e` to enable them for every project Run.
The MCP form supports stdio, HTTP and SSE, individual arguments, and environment
variables or headers. Advanced JSON editing remains available through
`M-x noema-capability-ui-register-mcp-json` and `p`.

MCP tests run only on explicit `t`, never during completion or refresh. They
use the resolver's current effective configuration without changing selection,
registering tools, or calling tools. The temporary session closes after the
test, with a 20-second deadline and at most 16 KiB of stderr. `Last test` is a
historical observation, separate from an agent session's live `Runtime` state.
OAuth-only endpoints may report an authentication error; the test does not
launch an authorization flow or manage a running agent's connections.

## Company completion

In a work block's leading control region, type `@@` to choose `@@agent`,
`@@session`, `@@ctx` or `@@skill`. Selecting a name inserts parentheses.
`@@skill(` offers valid selectable Skills with description, scope and state;
explicitly disabled Skills are excluded, while available Skills do not need
to be enabled for the whole project. `@@ctx(file:` completes project paths,
`@@ctx(cell:` completes document Cell ids, and `@@ctx(result:` completes work
output references; the bare `@@ctx(` list also offers `lineage:2`,
`lineage:3` and `none` (turn off automatic context). Session names and
`parent:child` prefixes are supported.
Knowledge-note and artifact ids remain explicit references.

The typing path reads memory only. Capabilities are prefetched on idle and
cached per project for 30 seconds, with one outstanding refresh per project.
Old responses cannot replace a newer resolution. Candidate descriptions are
reused until resolution changes. File candidates come from asynchronous,
nonrecursive directory queries (30-second cache, at most 2,000 names).
Manager writes reuse the returned resolution, and saving a Skill or capability
configuration invalidates completion data. Use `g` for an immediate refresh.

The manager's inspect buffer displays resolver output directly, including the
base source, shadowed definitions, ordered patches, selection reasons,
validation and runtime state.

## Agent construction

`run:prepare` resolves capabilities once. Enabled Skill content is added to the
same frozen context budget as other context. Enabled valid MCP definitions are
copied into `mcp_servers`. An active-only provenance snapshot is stored in
`capability_environment`; Skill content itself is omitted from this duplicate
snapshot because the bytes already exist in the frozen context item.

The Emacs worker consumes only this frozen `mcp_servers` list and preserves
stdio, HTTP and SSE fields in the ACP configuration. It does not rediscover
project Skills or MCPs.

## Test isolation

Global scope is machine state: whatever the developer has enabled in
`etc/noema/capabilities.json`, including Skills contributed by linked native
libraries, is resolved for every project run. Suites must not inherit it, or
an unrelated host Skill joins the prepared RunSpec's context and any exact
assertion on Skills, context refs or diagnostics fails on that machine only.

`tests/setup/global-capability-scope.ts` runs before every suite and points
`NOEMA_GLOBAL_CAPABILITIES` and `NOEMA_GLOBAL_SKILLS` at an empty temporary
directory, so only what a test installs is visible. A test that needs a
populated global scope stubs those variables itself, and a test that injects a
fake `userHome` must also pass `environment: {}` to the resolver, because the
environment is checked before `userHome`.
