---
name: noema-elisp-api
description: Use Noema's supported Emacs Lisp API for project identity, Skill/MCP configuration and durable Run cancellation. Use when evaluating Elisp in an existing Noema Emacs host; this is an operational API guide, not Markdown syntax or a work-document editor.
---

# Noema project API in Emacs

`noema-api.el` exposes project queries, capability resolution and mutations,
and cancellation through the existing worker. Read the relevant section of
`~/.config/emacs/docs/noema/design/elisp-api.md` before an unfamiliar call.

## Project queries

`noema-current-project`, `noema-project-root`, `noema-project-scope`,
`noema-project-workspace` and `noema-project-client-path` do not create a
Project. A durable Noema Project has `[project]` in its nearest `noema.toml`;
ordinary Agent sessions can exist outside that model. Use the existing
`noema-project-ensure` interaction only when the requested operation needs it.

```elisp
(list :project (noema-current-project)
      :scope (noema-project-scope default-directory))
```

## Skills, packs and MCP

Resolve with `noema-capability-list`, `noema-skill-list`, `noema-mcp-list`,
`noema-capability-config` or `noema-capability-resolve`. Async callbacks receive
`(result error-object)`; inspect the error before using the result.
`noema-capability-active` extracts selected ids from a resolution.
`:requested-skills` and `:requested-packs` select for a task without changing
persistent settings. `:scope 'global` avoids project discovery.

```elisp
(noema-capability-list
 :scope 'global :requested-packs '("noema-project")
 :callback (lambda (resolution error-object)
             (if error-object
                 (message "Noema capability lookup failed")
               (message "%S" (noema-capability-active resolution)))))
```

`noema-capability-set-enabled`, `noema-capability-set-patch`,
`noema-mcp-register`, `noema-pack-define` and `noema-skill-install` write through
the existing scoped service, then re-resolve. Querying is not authorization
to change the configuration or connect an MCP.

## Runtime and management

Pi has its own history and active pointers. Open `noema-pi-sessions` for the
Emacs companion and project conversations; do not promote or bind them into
Research. Use the `emacs:pi` API when coordinating
children. Read `docs/design/pi-sessions.md` for lifecycle details, including
unsaved empty conversations and strict native restore. Prompt documents use
the `noema-prompt-document` Skill and ordinary Markdown.

Use `noema-agent-cancel` with an actual Run id for requested cancellation.
Agent processes and Session operations use Emacs's shared `tools/agent/`
commands; look them up in `docs/design/agent-management.md` relative to the
Emacs configuration. Project Sessions, history, Attention and Findings keep
their existing entry points.

The retired JuText/Graph Board mutations, at-point Cell execution and
work-document editor commands are not part of this API. Existing model files,
RunSpecs and artifacts remain usable through their services; do not recreate
an editor or invent Cell identities to use a project capability.
