# Noema Jupyter Kernel Stack

This directory holds Noema's project-owned kernelspec templates and stable
kernel launchers. Python packages live in the `aaronnote-python` Conda
environment; Sage is resolved dynamically from the installed `sage` command.
There is **no Jupyter server process** — the Node cell
service (`server/lib/jupyter-cell.mjs`, orchestrating `server/jupyter/*`)
launches and talks to kernels directly over raw ZMQ, the same approach
Microsoft's VS Code Jupyter extension uses for local kernels (ported/adapted
from `microsoft/vscode-jupyter`, MIT). The browser-side rendering of cell
output and ipywidgets reuses the same official JupyterLab building blocks VS
Code Jupyter uses — see "Frontend rendering" below.

The runtime provides:

- an `aaronnote-python` Conda environment, reconciled from
  `etc/conda/aaronnote-python.yml`, with `ipykernel`, `ipywidgets`, and
  `bash_kernel`
- stable `python3`, `bash`, and `sagemath` kernelspec ids whose launchers read
  generated runtime metadata, so upgrades do not embed interpreter paths or a
  Sage version in notes
- kernelspec discovery matching Jupyter's own search order (this project's
  data dir and — unless disabled — the user's
  `~/Library/Jupyter`/`~/.local/share/jupyter` and system dirs)
- isolated Jupyter config/data/runtime directories under `jupyter/.jupyter`
- attaching to an already-running kernel via its connection file (e.g. a
  remembered `kernel-*.json` from an Emacs-managed remote-kernel workflow),
  instead of only ever launching kernels locally
- live ipywidgets comms through Noema's same-origin kernel channels
  WebSocket bridge (`server/lib/jupyter-kernel-ws.mjs`), which talks raw ZMQ
  directly rather than proxying to a Jupyter server

From the Noema notes repository, run `make setup` or `make runtime-update`.
Both are thin proxies to the central Emacs script
`scripts/aaronnote-runtime`. For compatibility, from `lisp/roam/aaronnote`
you can also run:

```sh
npm run jupyter:bootstrap
```

`npm run dev` (or the built app) starts Node's own `web-host.mjs`, which
launches kernel processes on demand — there is nothing else to start.

## Cell service behavior (`server/lib/jupyter-cell.mjs` + `server/jupyter/*`)

The Node cell service owns kernel lifecycle and each cell run:

- `server/jupyter/kernel-registry.mjs` launches (or attaches to) a kernel per
  note-script-file + kernel-name key, holding one persistent raw-ZMQ
  `@jupyterlab/services` `KernelConnection` per kernel for execution,
  interrupt, and restart. A kernel that dies unexpectedly self-heals on the
  next run — this **also bumps `widgetGeneration`**, so a stale browser
  ipywidgets connection from before the death is never reused.
- `server/jupyter/execution-message-handler.mjs` drives one `execute_request`
  and assembles outputs (stream merge/cap, display_id update-in-place,
  Output-widget scoping via `server/lib/jupyter-output-router.mjs`).
- Cell code and saved outputs live in a hidden `.cell/` directory beside the
  note (`<note>.<lang>.<session>.<ext>` script, `<note>.output.*.json` mirror).
  The output mirror is written atomically and a corrupt mirror is ignored
  rather than propagated as an error; concurrent cells sharing one kernel
  serialize their writes so they cannot clobber each other.
- Consecutive `stdout`/`stderr` stream chunks are merged, and total stream text
  is capped so a runaway loop cannot produce an unbounded payload. The inline
  widget view truncates long output further; **Popout** shows the full capped
  output.
- A hung execution (no `execute_reply` within `AARONNOTE_JUPYTER_EXEC_TIMEOUT_MS`)
  is escalated: interrupt the kernel, wait `AARONNOTE_JUPYTER_INTERRUPT_GRACE_MS`,
  then surface a timeout error — the kernel process itself is left alive so
  the next cell doesn't lose in-kernel state.
- On startup, and whenever `web-host.mjs` shuts down cleanly, kernel processes
  this instance owns are torn down; a `process.on("exit")` fallback SIGKILLs
  any still-alive owned process groups if the async shutdown path didn't run.
  A previous instance's crash leaves an `aaronnote-owned.json` sidecar under
  `jupyter/.jupyter/runtime/`; the next instance sweeps it on first use,
  killing any orphaned kernel process it can still find and confirm (by PID +
  matching connection-file path in its command line).

### Frontend rendering (browser)

Cell output is rendered by the official JupyterLab stack — the same pipeline
VS Code Jupyter uses — rather than a hand-rolled MIME renderer:

- `src/jupyter-rendermime.ts` builds a `@jupyterlab/rendermime` registry and
  renders outputs with `@jupyterlab/outputarea`'s `OutputArea`. This gives
  upstream-identical layout, MIME preference, and error/stream formatting.
  Noema layers in a KaTeX LaTeX typesetter, an HTML renderer that sandboxes
  script-bearing HTML (e.g. Sage's threejs viewer) in an auto-sizing iframe, and
  routes math-only HTML to KaTeX.
- `src/jupyter-widget-runtime.ts` is a `KernelWidgetManager` over the live
  kernel. It mounts **kernel-state-first** (`restoreWidgets`, the ipywidgets 8
  control comm), so `@interact` sliders round-trip and Output areas update in
  place; captured comm-message replay is only a fallback for older ipywidgets.
- `server/lib/jupyter-output-router.mjs` routes display output produced inside
  an ipywidgets Output widget's context (matched by the widget's published
  `msg_id`) away from the top-level cell output and groups it by comm id. The
  client seeds the widget with those outputs after it mounts, so an `@interact`
  cell's initial plot shows *inside* the widget instead of duplicated above it.

Both frontend modules are large and load lazily (their own bundle chunks), so
they stay out of the main editor bundle until a cell actually produces output.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `AARONNOTE_JUPYTER_KERNEL_IDLE_TTL_MS` | `600000` | Idle kernel reap delay. |
| `AARONNOTE_JUPYTER_CLEANUP_INTERVAL_MS` | `30000` | How often the idle sweep runs. |
| `AARONNOTE_JUPYTER_EXEC_TIMEOUT_MS` | `0` (off) | Per-execution timeout before interrupt escalation. |
| `AARONNOTE_JUPYTER_INTERRUPT_GRACE_MS` | `5000` | Grace period after interrupting a timed-out execution. |
| `AARONNOTE_JUPYTER_MAX_STREAM_BYTES` | `1048576` | Cap on merged stream text per run before truncation. |
| `AARONNOTE_JUPYTER_MAX_WIDGET_MESSAGES` / `_BYTES` | `512` / `8388608` | Caps on captured widget comm messages per run. |
| `AARONNOTE_JUPYTER_USE_HOME_KERNELS` | `1` | Also search `~/Library/Jupyter`, `~/.local/share/jupyter`, and system Jupyter dirs for kernelspecs. |
| `AARONNOTE_JUPYTER_ALLOWED_KERNELS` | unset | Comma-separated kernelspec name allowlist. |
| `AARONNOTE_JUPYTER_ATTACH_DIRS` | unset | `:`-separated extra directories to search for attachable `kernel-*.json` connection files, beyond `jupyter/.jupyter/runtime`. |
| `AARONNOTE_JUPYTER_DEFAULT_LANGUAGE` | `python` | Default language for a newly inserted bare cell; supplied from project `:aaronnote-jupyter` settings. |
| `AARONNOTE_JUPYTER_DEFAULT_KERNEL` | derived | Stable default kernelspec id (`sagemath` for Sage, otherwise `python3`) unless the project overrides it. |
| `AARONNOTE_JUPYTER_DEFAULT_SESSION` | `default` | Default persistent cell session name. |

Removed: `AARONNOTE_JUPYTER_HOST`/`_PORT`/`_URL`/`_SERVER_IDLE_TTL_MS` (there is
no server process to bind or point at anymore). To use a kernel that isn't
launched by this project — including a remote one over SSH port-forwarding —
select `attach:<connection-file-name>` as the kernel; Noema connects to it
directly instead of spawning a process for it.

## Known trade-offs

- Kernel processes are spawned with an **empty-token connection** (raw ZMQ has
  no auth concept beyond the HMAC signing key in the connection file, which
  never leaves the local machine): any local process that can read the
  connection file can talk to the kernel. This is a single-user, local-only
  design.
- Core ipywidgets assets are bundled. Custom widget AMD modules try local
  `/nbextensions` first (served from disk, no server involved) and then load
  automatically from jsDelivr. Custom widget JavaScript runs in the Noema
  page and therefore has the same privileges as the editor UI.
- Widget comm state is intentionally not saved in the output mirror. Reloading
  the page or restarting the kernel leaves a stale output that must be rerun.
- Attached kernels (connected via connection file rather than launched by this
  project) are never restarted or force-killed by Noema — only
  disconnected. Interrupting one only works if its kernelspec supports message
  interrupt (SIGINT requires owning the process).
