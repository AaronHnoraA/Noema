# Upstream implementation ownership

gptel and Magent remain internalized. On 2026-09-15 the user authorized moving
the pristine ACP toolchain to package-vc. These three packages retain the exact
audited revisions below, without a simultaneous upstream version upgrade.
Noema's hidden-output optimization now lives in `lisp/noema-agent-render.el`;
the package source has no local modifications.

| Tree | Upstream | Revision | Noema role |
|---|---|---|---|
| `upstream/gptel/` | `karthink/gptel` | `fc6963634af2f76a9909ad674e2c0b3f005e60b5` | arbitrary-buffer composition, context, presets, transient controls, rewrite review, lightweight inference |
| package-vc `agent-shell` | `xenodium/agent-shell` | `6a83589393fb67725f288d08d6f12d136564db0e` | structured Emacs agent session UI and event stream |
| package-vc `acp` | `xenodium/acp.el` | `7d5c16ebcf2af86aa0f14ad9ae0ce45df4e8c8a5` | ACP transport and protocol implementation |
| package-vc `shell-maker` | `xenodium/shell-maker` | `bb5e3aef17686c1c859c366eb83831b0046dc75a` | comint substrate required by agent-shell |
| `upstream/magent/` | `Jamie-Cui/magent` plus local integration work | upstream base `412a12cbe9151d11eb66ce3dbdd893324fb36825`, followed by the audited local integration present at migration | queue, ledger, permissions, agent runtime and gptel/agent-shell integration |
| `upstream/codex-cli/` | previously internalized Codex CLI Emacs integration | source present at migration time | terminal/CLI compatibility and reference implementation |
| `upstream/claude-code-ide/` | previously internalized Claude Code IDE integration | source present at migration time | terminal/MCP compatibility and reference implementation |

Each upstream directory retains its own license, history-facing documentation,
tests and source layout. Noema-specific code lives in `lisp/`; upstream symbols
remain intact so mature behavior is reused instead of imperfectly rewritten.
