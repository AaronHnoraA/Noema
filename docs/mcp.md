# Noema MCP

Noema exposes its live headless kernel as a Streamable HTTP MCP server.  The
Emacs Noema integration starts and supervises that kernel, registers the
repository at `~/Documents/Noema` (or `NOEMA_ROOT`), and publishes the current
loopback endpoint only after the repository is ready.

On macOS, the endpoint descriptor is normally written to:

```text
~/Library/Application Support/Noema/state/runtime/mcp.json
```

The exact location follows Noema's host state directory. The
descriptor is mode `0600`, is replaced atomically when the kernel restarts on a
new port, and is removed when the host stops or loses kernel health. A typical
descriptor is:

```json
{
  "name": "Noema",
  "transport": "streamable-http",
  "url": "http://127.0.0.1:43128/mcp",
  "noteRoot": "/Users/example/Documents/Noema",
  "notebook": "20260826000000-example",
  "ownedKernel": true
}
```

Configure an MCP client with the descriptor's `url` and Streamable HTTP
transport while Noema is running. Do not save a random port in permanent
configuration: read the descriptor again after the Emacs/Noema host restarts.

The `document` tool accepts repository-native Markdown paths for the main
operations:

- `get`: `notebook`, `path`
- `create`: `notebook`, `path`, optional `title` and `markdown`
- `list`: `notebook`, optional directory `path`
- `rename`: `notebook`, `source_path`, `title`
- `move`: `notebook`, `source_path`, target `path`

These operations read and write the Markdown files in place and refresh the
same Noema index used by Emacs. The MCP endpoint remains
loopback-only and uses the kernel's normal authentication, administrator, and
read-only checks.

## Public Server mode MCP

Server mode exposes a separate, unauthenticated Streamable HTTP endpoint at
`https://wiki.pwo101.top/mcp` (or `/mcp` on another Server mode host). It reads
the same published catalog as the public Wiki. It provides four read-only
tools: `search_notes`, `list_notes`, `read_note` and `list_tags`. A note path is
the public path returned by search or list, such as
`public/Public-README/example.md`. Hidden pages and private repositories are
absent from this catalog. Server mode does not start the Go kernel or expose
its writable `/mcp/research` and `/mcp/coordinator` surfaces.

From AaronEmacs, `make noema-server-deploy` builds, uploads, restarts and
checks the configured remote service. The ignored local files
`server-config/runtime.json` and `server-config/deploy.json` in the Noema tree
hold the site and SSH settings; initialize examples with
`make noema-server-config-init`.

## Project MCP selection

The supervised Noema endpoint is also the built-in `noema` capability. Projects
may define additional stdio, HTTP or SSE MCP servers, enable/disable them and
patch their configuration in `noema-capabilities.json`. Run preparation copies
the resolved active definitions into the immutable RunSpec; the Emacs ACP worker
does not rediscover them. Persistent definition/configuration is separate from
live runtime state. See [Project Skills and MCP capabilities](capabilities.md).
