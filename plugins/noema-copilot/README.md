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

## Inline completion controls

In Insert mode, Copilot keeps matching ghost text visible while you type and
refreshes the suggestion after the normal idle delay. The primary modifier is
Command on macOS and Ctrl on Windows/Linux.

- `Command/Ctrl+]` accepts the complete suggestion.
- `Command/Ctrl+\` accepts the next word or structural unit.
- `Command/Ctrl+}` (`Shift+]`) starts a Vim `s`-style jump. Type a target
  character first; Noema then labels matching occurrences in the visible
  ghost. Type a label to accept exactly through that occurrence. Backspace
  edits the label prefix and Escape leaves the suggestion unaccepted. A small
  armed-state hint stays visible while S-jump owns input. Each target/label
  stage expires after 1.5 seconds; navigation, paste, drop, and other
  non-character input cancel the jump and pass through unchanged.

Multiline suggestions render through the visible viewport. When no Copilot
suggestion is present, the same navigation keys retain their snippet-tabstop
and structural-delimiter behavior. Formula requests are bounded to the active
formula and sent as a virtual LaTeX document, while accepted text is still
inserted into the original Markdown source; existing `}`, `\)`, and `\]`
closers are preserved rather than duplicated.
