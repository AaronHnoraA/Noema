# claude-code-ide vendor

This directory contains the vendored `claude-code-ide` source tree used by
`ai-workbench`.

Upstream project documentation remains in `README.org`. This `README.md` only
explains the local vendoring role of the directory.

Local vendoring rules for this copy:

- keep source `.el` files, tests, license, and relevant helper scripts
- drop `.git`, compiled `.elc`, autoloads, and package metadata
- treat `elpa/claude-code-ide/` as the current upstream import source
