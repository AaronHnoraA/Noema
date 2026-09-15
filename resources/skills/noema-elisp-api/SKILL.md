---
name: noema-elisp-api
description: Use Noema's public semantic Emacs Lisp API to inspect or update a Noema project, DAG, work cells, agent runs, Skills, and MCP configuration. Use when an agent can evaluate Elisp inside the user's Noema Emacs host; prefer this API over editing `.noema` JSON, buffer text, properties, or overlays directly.
---

# Noema Elisp API

Evaluate small programs against the public functions in `noema-api.el`. Start
with context queries and keep stable WorkNode ids rather than buffer positions.

```elisp
(let* ((project (noema-current-project))
       (node (noema-current-node))
       (children (and node (noema-node-children node))))
  (list :project project
        :node (and node (noema-node-id node))
        :children (mapcar #'noema-node-id children)))
```

Queries have no external effects:

- `noema-current-project`, `noema-current-document`, `noema-current-cell`,
  `noema-current-node`, `noema-node-id`
- `noema-node-parents`, `noema-node-children`
- async `noema-capability-list`, `noema-skill-list`, `noema-mcp-list`,
  `noema-capability-config`, `noema-capability-resolve`; use
  `noema-capability-active` on a returned resolution

Async callbacks receive `(result error-object)`. Always inspect the error:

```elisp
(noema-capability-list
 :project (noema-current-project)
 :callback
 (lambda (environment error-object)
   (if error-object
       (message "Capability query failed: %S" error-object)
     (message "Effective capabilities: %S"
              (noema-capability-active environment)))))
```

Semantic mutations update the current JuText document as validated undoable
operations: `noema-create-work`, `noema-create-checkpoint`, `noema-link`,
`noema-unlink`, and `noema-set-node-state`. For example:

```elisp
(let* ((parent (noema-current-node))
       (child-id (noema-create-work
                  "Verify the boundary case"
                  (list (noema-node-id parent)))))
  (noema-set-node-state child-id "open")
  child-id)
```

Persistent capability mutations are async and change the project's
`noema-capabilities.json`: `noema-capability-set-enabled`,
`noema-capability-set-patch`, and `noema-mcp-register`. A Skill patch is a JSON
Merge Patch; `content_append` is the supported additive instruction field.

Runtime effects may start processes or execute work: `noema-run-cell`,
`noema-agent-run`, `noema-agent-resume`, `noema-agent-cancel`, and
`noema-run-project-file` for supported Jupyter/Python project files. Confirm
that the intended work cell and project are current before invoking them.

Do not insert raw `.noema` JSON, parse JuText with regular expressions, or
change overlays/text properties to perform domain operations. Use raw Emacs
buffer manipulation only when no semantic API exists, and report that boundary
instead of presenting the edit as a supported Noema operation.
