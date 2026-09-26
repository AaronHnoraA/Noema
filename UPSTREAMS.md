# Upstream implementation ownership

gptel and Magent remain internalized. On 2026-09-15 the user authorized moving
the pristine ACP toolchain to package-vc. On 2026-09-26 the user asked to update
it together with the pristine gptel snapshot: acp.el 0.15.2, shell-maker 0.97.3,
agent-shell 0.79.2 and gptel 0.9.9.6 are pinned below.  Every upstream
definition Noema and the host configuration call was checked to still exist.
Noema's hidden-output optimization now lives in `lisp/noema-agent-render.el`;
the package source has no local modifications.

| Tree | Upstream | Revision | Noema role |
|---|---|---|---|
| `upstream/gptel/` | `karthink/gptel` | `ec25a41fb8bebf5ea08341a9d8c70c0ee907ee23` | arbitrary-buffer composition, context, presets, transient controls, rewrite review, lightweight inference |
| package-vc `agent-shell` | `xenodium/agent-shell` | `55d7148505da2433a30b1228092e17b0775ffa25` | structured Emacs agent session UI and event stream |
| package-vc `acp` | `xenodium/acp.el` | `242cef63d76cc1073485847f67a21f6d8406d158` | ACP transport and protocol implementation |
| package-vc `shell-maker` | `xenodium/shell-maker` | `f448a74a8eded23aa42f8d60a41c5d8d3a183d07` | comint substrate required by agent-shell |
| `upstream/magent/` | `Jamie-Cui/magent` plus local integration work | upstream base `412a12cbe9151d11eb66ce3dbdd893324fb36825`, followed by the audited local integration present at migration | queue, ledger, permissions, agent runtime and gptel/agent-shell integration |
| `upstream/codex-cli/` | previously internalized Codex CLI Emacs integration | source present at migration time | terminal/CLI compatibility and reference implementation |
| `upstream/claude-code-ide/` | previously internalized Claude Code IDE integration | source present at migration time | terminal/MCP compatibility and reference implementation |

Each upstream directory retains its own license, history-facing documentation,
tests and source layout. Noema-specific code lives in `lisp/`; upstream symbols
remain intact so mature behavior is reused instead of imperfectly rewritten.
