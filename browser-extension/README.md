# Noema Capture extension

Load this directory as an unpacked Manifest V3 extension. Start the local Noema host, open the extension options, and enter its `http://127.0.0.1:<port>` URL plus the token stored in Noema's runtime state as `capture-token`.

The extension requests only `activeTab`, `scripting`, `contextMenus`, and `storage`. It sends a capture only after the toolbar button or context-menu command is invoked. The local Go research store, not the extension service worker, owns accepted capture state.

Generic capture does not request persistent access to any website. Provider-specific host permissions must not be added unless a separately reviewed adapter genuinely needs them; ChatGPT and Claude are currently handled through their official export files instead.
