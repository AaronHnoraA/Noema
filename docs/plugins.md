# Desktop plugins

Noema.app loads main-process plugins before it builds the native application
menu or starts the local host. A plugin package may also own renderer code that
is bundled for another adapter; the Copilot plugin uses that split to preserve
the existing Emacs bridge.

## Managing plugins

Open **Noema → Settings… → Plugins**. A change is written to
`plugins.json` in Electron's Noema user-data directory and takes effect after
the app restarts. Bundled plugins live under the application's `plugins/`
directory; personal plugins may be installed as one-directory packages under
the user-data `plugins/` directory.

For diagnostics and temporary launch overrides:

```sh
NOEMA_ENABLED_PLUGINS=noema.zh-cn /Applications/Noema.app/Contents/MacOS/Noema
NOEMA_DISABLED_PLUGINS=noema.zh-cn /Applications/Noema.app/Contents/MacOS/Noema
NOEMA_PLUGIN_DIRS=/absolute/plugin/root /Applications/Noema.app/Contents/MacOS/Noema
```

Environment overrides take precedence over the settings file and lock the
corresponding switch for that run.

## Package format

Each immediate child of a plugin root must contain `plugin.json`:

```json
{
  "id": "example.my-plugin",
  "name": "My plugin",
  "description": "What it changes.",
  "version": "1.0.0",
  "apiVersion": 1,
  "main": "main.mjs",
  "enabledByDefault": false
}
```

`main.mjs` exports `activate(api)`. API version 1 provides:

- `registerMenuTransformer(fn)` for native application and title-bar menus;
- `registerDialogTransformer(fn)` for open, save, and message dialogs;
- `registerHostEnvironmentTransformer(fn)` for the standalone local-host
  environment assembled by Noema.app;
- `registerRendererBootstrap({ source, payload, cloak })` for an idempotent
  renderer function injected before the application bundle, with a `dom-ready`
  fallback;
- `onWebContentsCreated(fn)` for scoped window observation;
- the read-only manifest, plugin/state/application paths, Electron `app`, and
  plugin logging.

Plugins execute trusted JavaScript in the Electron main process. Only install
plugins whose source you trust. A plugin entry must be a local `.mjs` filename
inside its own directory; duplicate IDs and unsupported API versions are
rejected. A broken plugin is logged and skipped so Noema can continue starting.

## Built-in first implementation

`plugins/noema-zh-cn` is the first bundled plugin. It was migrated from
[`PWO-CHINA/noema-zh-patch`](https://github.com/PWO-CHINA/noema-zh-patch) at
commit `8ff36eb0cfd07081525bb9fe8bac3137fd395a72`. Its dictionary translates
native menus, dialogs, configuration/Wiki/editor chrome, and dynamic messages.
The renderer explicitly prunes `.cm-content`, so note text is never translated.

`plugins/noema-copilot` packages the existing inline-completion renderer as an
always-active built-in plugin. Noema.app lazily starts its packaged Copilot
language server. Emacs-started Noema continues forwarding to Emacs's existing
`copilot.el` connection and never starts a second local server.
