# Noema MCP

Noema exposes its live kernel as a Streamable HTTP MCP server. The desktop app
starts that kernel, registers the repository at `~/Documents/Noema` (or
`NOEMA_ROOT`), and publishes the current loopback endpoint only after the
repository is ready.

On macOS, the endpoint descriptor is normally written to:

```text
~/Library/Application Support/Noema/state/runtime/mcp.json
```

The exact location follows the desktop application's user-data directory. The
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
configuration: read the descriptor again after an application restart.

The `document` tool accepts repository-native Markdown paths for the main
operations:

- `get`: `notebook`, `path`
- `create`: `notebook`, `path`, optional `title` and `markdown`
- `list`: `notebook`, optional directory `path`
- `rename`: `notebook`, `source_path`, `title`
- `move`: `notebook`, `source_path`, target `path`

These operations read and write the Markdown files in place and refresh the
same Noema index used by the desktop and Emacs hosts. The MCP endpoint remains
loopback-only and uses the kernel's normal authentication, administrator, and
read-only checks.
