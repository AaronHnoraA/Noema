# Noema semantic Emacs Lisp API

`lisp/noema-api.el` is the public domain boundary for JuText, the Graph Board,
scripts and compatible agents. Functions work with projects, Cells, WorkNodes,
Runs and capabilities. Buffer rendering, text properties, transport channels,
and ACP process details remain private backends.

## Queries

These do not start external work:

| Function | Result |
|---|---|
| `noema-current-project` | containing project root for a path or buffer |
| `noema-current-document` | current semantic WorkDocument |
| `noema-current-cell` | Cell at point |
| `noema-current-node` | WorkNode at point |
| `noema-node-id` | stable id for a WorkNode |
| `noema-node-parents` / `noema-node-children` | related WorkNodes |
| `noema-capability-list` | authoritative Skill/MCP resolution |
| `noema-skill-list` / `noema-mcp-list` | one domain's effective records |
| `noema-capability-cached` / `noema-capability-refresh` | per-project cached queries and coalesced asynchronous refresh |
| `noema-skill-install` | create or import a project Skill without overwriting existing files |
| `noema-mcp-probe` | explicitly test a resolved MCP and list its tools in a temporary session |
| `noema-capability-config` | canonical project capability configuration |
| `noema-capability-resolve` | one resolved effective record |
| `noema-capability-active` | active Skill/MCP ids from a resolution |

Capability queries are asynchronous because they cross the Emacs/host boundary.
Their callback receives `(result error-object)`.

## Semantic mutations

`noema-create-node`, `noema-create-work`, `noema-create-checkpoint`,
`noema-link`, `noema-unlink`, `noema-set-node-state`, and `noema-open-node` use
the existing validated JuText structural transaction. The edits remain
undoable and update the Graph Board through the established model path.

`noema-capability-set-enabled`, `noema-capability-set-patch`, and
`noema-mcp-register` atomically mutate the selected Noema capability document
and then re-resolve it. Capability query/mutation/install/probe APIs accept
`:scope 'global` to operate without project discovery; omitted scope retains
the project API semantics. Global writes invalidate all editor capability
caches, since project resolutions inherit them. Native linked client files
are never rewritten by these mutations. The UI invokes these functions;
it does not implement its own mutations.

## Runtime effects

`noema-run-cell` (also `noema-agent-run`) validates and saves the work document,
then dispatches through the existing worker and frozen RunSpec path.
`noema-agent-resume` chooses continued/named session routing.
`noema-agent-cancel` requests cancellation of a durable Run.
`noema-run-project-file` runs a project `.py` or `.ipynb` from the current
WorkNode and retains Noema's explicit local-execution confirmation.

These functions can start or affect external processes. MCP connection state is
not changed by a capability query.

## Script example

This program queries project and graph state, resolves capabilities, and creates
a downstream semantic WorkNode without inserting JuText manually:

```elisp
(let* ((project (or (noema-current-project)
                    (user-error "Visit a Noema project first")))
       (parent (or (noema-current-node)
                   (user-error "Put point on a WorkNode")))
       (parent-id (noema-node-id parent))
       (child-id (noema-create-work "Audit the effective capability boundary"
                                    (list parent-id))))
  (noema-capability-list
   :project project
   :callback
   (lambda (environment error-object)
     (if error-object
         (message "Noema capability query failed: %S" error-object)
       (message "Created %s; active capabilities: %S"
                child-id (noema-capability-active environment)))))
  child-id)
```

A runnable copy is in `examples/noema-api-example.el`. The bundled
`noema-elisp-api` Skill gives agents the same operational contract.

## Compatibility boundary

The API currently delegates structural changes to the mature
`noema-research-op-*` transaction backend and Run effects to
`noema-agent-worker`. Those functions are implementation details: new UI,
scripts and agent instructions should call `noema-*` public functions instead.
The `aaronnote:api:*` names remain wire compatibility contracts, not the Elisp
domain interface.
