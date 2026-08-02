# GitHub Copilot plugin

This built-in plugin owns Noema's inline-completion renderer and desktop
language-server selection.

- In Noema.app it points the local host at the packaged
  `@github/copilot-language-server`. The process starts lazily on the first
  completion request, stops after the existing idle timeout, and restarts on
  demand. Authentication, state, and cache files live under this plugin's
  writable Noema application-data directory; explicit `COPILOT_HOME`,
  `COPILOT_CACHE_HOME`, and XDG environment settings remain overrides.
- In Emacs it does not start a desktop server. `init-aaronnote.el` keeps
  `AARONNOTE_COPILOT_DISABLE_LOCAL=1`, and `web-host.mjs` forwards requests to
  Emacs's existing `copilot.el` JSON-RPC connection through the gateway.
- Server reader mode does not request completions and therefore does not start
  the language server.

Copilot is part of the built-in authoring surface and is loaded automatically;
the configuration page reports it as active but does not require an enable
switch.
