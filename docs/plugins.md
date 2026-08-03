# Desktop plugins

Noema.app discovers plugin manifests before it starts the local host. Built-in
renderer adapters are compiled with the web application, while desktop-native
behavior is implemented in the Tauri host. The Copilot plugin keeps its split
renderer/core design so the Emacs bridge remains unchanged.

## Managing plugins

Open **Noema → Settings… → Plugins**. A change is written to
`plugins.json` in Tauri's Noema application-data directory and takes effect after
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

The historical `main.mjs` field remains in API-version-1 manifests as package
metadata, but Noema.app no longer executes arbitrary JavaScript in a privileged
desktop process. Renderer code must be included by the web build, and new native
capabilities must be implemented as reviewed Tauri commands. Personal manifests
can still be discovered and enabled, but show as pending until a corresponding
renderer/native adapter is installed.

## Built-in first implementation

`plugins/noema-zh-cn` is the first bundled plugin. It was migrated from
[`PWO-CHINA/noema-zh-patch`](https://github.com/PWO-CHINA/noema-zh-patch) at
commit `8ff36eb0cfd07081525bb9fe8bac3137fd395a72`. Its dictionary translates
configuration/Wiki/editor chrome and dynamic messages.
The renderer explicitly prunes `.cm-content`, so note text is never translated.

`plugins/noema-copilot` packages the existing inline-completion renderer as an
always-active built-in plugin. Noema.app lazily starts its packaged Copilot
language server. Emacs-started Noema continues forwarding to Emacs's existing
`copilot.el` connection and never starts a second local server.
