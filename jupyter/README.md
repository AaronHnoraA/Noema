# Noema Jupyter Kernel Stack

This directory holds Noema's project-owned kernelspec templates and stable
kernel launchers. Python packages live in the `aaronnote-python` Conda
environment; Sage is resolved dynamically from the installed `sage` command.
There is **no Jupyter server process**. The Node cell service
(`server/lib/jupyter-cell.mjs`, orchestrating `server/jupyter/*`) talks to
kernels directly over raw ZMQ, the same approach
Microsoft's VS Code Jupyter extension uses for local kernels (ported/adapted
from `microsoft/vscode-jupyter`, MIT). The browser-side rendering of cell
output and ipywidgets reuses the same official JupyterLab building blocks VS
Code Jupyter uses — see "Frontend rendering" below.

In Emacs host mode, the Remote broker owns kernelspec discovery, process
placement, connection files, and the atomic five-channel forward group.
Node retains raw-ZMQ execution and the browser bridge. The kernel, cwd,
environment, hidden `.cell/` notebooks, and custom widget assets therefore follow
the note's owning Target. Target `local` uses the same broker path. Standalone
desktop host mode keeps the direct Node launcher.

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
- connecting to a Jupyter server that already exists — a lab server, a
  JupyterHub, or a kernel gateway — over HTTP(S); see "Remote Jupyter servers"
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

`npm run dev` (or the built app) starts `web-host.mjs`; there is no Jupyter
server or target-side Noema/Node service to start.

## Cell service behavior (`server/lib/jupyter-cell.mjs` + `server/jupyter/*`)

The Node cell service owns kernel lifecycle and each cell run:

- `server/jupyter/kernel-registry.mjs` obtains (or attaches to) a kernel per
  note-script-file + kernel-name key, holding one persistent raw-ZMQ
  `@jupyterlab/services` `KernelConnection` per kernel for execution,
  interrupt, and restart. A kernel that dies unexpectedly self-heals on the
  next run — this **also bumps `widgetGeneration`**, so a stale browser
  ipywidgets connection from before the death is never reused.
- `server/jupyter/execution-message-handler.mjs` drives one `execute_request`
  and assembles outputs (stream merge/cap, display_id update-in-place,
  Output-widget scoping via `server/lib/jupyter-output-router.mjs`).
- Each language/session is one standard nbformat 4.5 notebook beside the note:
  `.cell/<note>.<lang>.<session>.ipynb`. Stable Noema ids are standard `cell.id`;
  code, counts, and portable output use `source`, `execution_count`, and
  `outputs`; private revision/widget/UI state lives in `cell.metadata.noema`.
  The whole notebook is replaced atomically, and concurrent result writes are
  serialized so they cannot clobber source or each other. Invalid notebook JSON
  is reported instead of silently discarding its source.
  The filename dimension is the notebook language, not the kernelspec: a Sage
  kernel therefore uses `<note>.python.<session>.ipynb`, with `sagemath` kept
  in `metadata.kernelspec`. Legacy `.sage.` names migrate on first open.
- A standalone external ipynb may predate nbformat cell ids. Noema gives such
  cells deterministic transient ids for document/UI operations but omits those
  ids again when serializing, so managing or saving it does not rewrite all of
  its old cells. Newly inserted/split/duplicated cells still receive persisted
  standard ids. Notebooks without language metadata default to Python.
- The kernels endpoint publishes one flattened `choices` catalog for both the
  Web workspace and Emacs. It includes broker-discovered kernelspecs, attach
  targets, and configured Jupyter-server kernels/running targets; clients do
  not apply a second language filter. A private running kernel remains
  connectable only by its owning notebook.
- Consecutive `stdout`/`stderr` stream chunks are merged, and total stream text
  is capped so a runaway loop cannot produce an unbounded payload. The inline
  widget view truncates long output further; **Popout** shows the full capped
  output.
- `server/jupyter/kernel-requests.mjs` serves completion, inspection,
  `is_complete`, history, and `comm_info`. All are bounded in time: the kernel
  services the shell channel strictly in order, so a completion issued during a
  long run would otherwise block until that run finished.
- Cells can read stdin. `input()`/`getpass()` prompt in the cell; cancelling
  answers EOF so the cell raises `EOFError` rather than leaving the kernel — and
  every other cell sharing it — blocked on a read. With no UI able to answer,
  `allow_stdin` is not advertised at all and `input()` fails immediately.
- Output streams live. iopub is published as patches over the editor's existing
  SSE channel while the cell runs; the execute response stays authoritative and
  the client reconciles against it, so a dropped frame costs only smoothness.
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

In Emacs host mode, transport loss closes only the five forwards. Remote
recovery probes the target process and recreates the channel group. A surviving
kernel keeps its variables; a dead kernel is relaunched on the next execution,
bumps the widget generation, and reports `stateLost`. Missing target
`python3`, `jupyter`, or the exact selected kernelspec is an explicit Doctor
error—there is no automatic install and no client fallback.

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
| `AARONNOTE_JUPYTER_SHUTDOWN_GRACE_MS` | `2000` | How long an owned kernel gets to answer `shutdown_request` before SIGTERM. |
| `AARONNOTE_JUPYTER_INTROSPECT_TIMEOUT_MS` | `3000` | Bound on completion/inspection replies (doubled for inspect and history). |
| `AARONNOTE_JUPYTER_STDIN_TIMEOUT_MS` | `300000` | How long a cell may wait for `input()`; `0` waits forever, as Jupyter does. |
| `AARONNOTE_JUPYTER_LIVE_FLUSH_MS` | `80` | Coalescing window for live output frames. |
| `AARONNOTE_JUPYTER_SERVERS` | unset | Standalone-host-mode remote Jupyter servers, as JSON (see below). |

Removed: `AARONNOTE_JUPYTER_HOST`/`_PORT`/`_URL`/`_SERVER_IDLE_TTL_MS`. Noema
still never *starts* a Jupyter server, and pointing one env var at a URL was
never enough to describe one. To use a kernel this project didn't launch:

- `attach:<connection-file-name>` connects to a running kernel through its
  connection file (raw ZMQ — over SSH port-forwarding, if it is remote);
- `server:<id>:<kernelspec>` starts a kernel on a Jupyter server reached over
  HTTP(S), and `server:<id>:kernel:<kernel-id>` adopts one already running
  there.

## Remote Jupyter servers

`server:` kernels talk to a real Jupyter server, JupyterHub, or kernel gateway
over REST + WebSocket (`server/jupyter/server-{auth,connection,registry}.mjs`,
built on a small cookie- and TLS-aware HTTP client in
`server/jupyter/http-client.mjs` — Node's global fetch keeps no cookies, and
the notebook password login is a cookie flow).

Kernels are started through the **sessions** API on a real server, so the
kernel is bound to a path, gets a working directory, and appears in the
server's own UI; shutting one down removes the session too. A gateway has no
sessions or contents API, so `kind: "gateway"` starts bare kernels instead.

In **Emacs host mode the broker owns the server list** (`my/noema-jupyter-servers`):
it reads secrets from `auth-source`, and for a server that only exists on a
Remote target it opens a channel and hands Noema a client-side URL. A target
that cannot provide a channel is an error, never a client-side connection.

In **standalone host mode** the same shape comes from `AARONNOTE_JUPYTER_SERVERS`,
a JSON array of `{ id, displayName, url, kind, auth, token, password, user,
allowUnauthorized, serverName }`. There is no Remote framework here, so every
server must already be reachable from this machine.

The browser's ipywidgets connection is bridged to the *server's* own
`/api/kernels/<id>/channels` for these kernels rather than to ZMQ
(`server/lib/jupyter-kernel-ws.mjs`), because the upstream handshake needs auth
headers and TLS options a browser WebSocket cannot carry.

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
- A live widget transport cannot be persisted in the notebook. Captured fallback
  messages and a runtime stamp may be retained under `cell.metadata.noema`, but
  restarting the kernel leaves stale widget output that must be rerun.
- Attached kernels (connected via connection file rather than launched by this
  project) are never restarted or force-killed by Noema — only
  disconnected. Interrupting one only works if its kernelspec supports message
  interrupt (SIGINT requires owning the process).
- A `server:` kernel's credentials are held for the life of the connection and
  reused for both REST and the WebSocket handshake. `allowUnauthorized` (Emacs:
  `:insecure`) disables TLS verification for that server only — it is never set
  process-wide — but it does disable it completely, so use it for a known
  self-signed lab certificate, not as a way past an unexplained TLS error.
- A `server:` kernel's cwd is decided by the server from the session path, which
  is derived from the note's base name at the server's root directory. The
  server has its own filesystem; a client-side path would name a directory that
  does not exist there.
