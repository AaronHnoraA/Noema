# org-roam and org-roam-ui architecture study

Reviewed 2026-08-04:

- `org-roam/org-roam` at `903bd4ec56d29247990d005ed9052c201e18b812`
- `org-roam/org-roam-ui` at `2894dcbf56d2eca8d3cae2b1ae183f51724b5db6`

Noema does not depend on Emacs or an org-roam process at runtime. This review
identifies the useful invariants and implements them in the standalone
Markdown/SQLite architecture.

## Database and synchronization

org-roam's useful boundary is that files are authoritative and SQLite is a
disposable projection. Its `files`, `nodes`, `aliases`, `tags`, and `links`
tables preserve stable node identity and normalized relationships. A per-file
content hash avoids reparsing unchanged files; update, delete, and rename paths
repair the projection transactionally, while a full sync remains available for
self-healing.

Noema's `wiki.db` follows the same model with Markdown-specific extensions:

| Invariant | Noema implementation |
| --- | --- |
| Source files are authoritative | Git-owned Markdown is never reconstructed from SQLite. |
| Stable identity is separate from location | `page_key`/page ID survives title, namespace, and path changes. |
| Repeated relationships are normalized | aliases, tags, links, dependencies, and backlinks are relational rows rather than serialized page fields. |
| Incremental updates are content-aware | changed files flow through the shared Wiki refresh queue; unchanged projections are skipped. |
| Full sync is repair, not the ordinary write path | topology/schema changes and scheduled self-heal rebuild atomically; normal saves refresh affected paths. |

Unlike org-roam's one-process editor hooks, Noema has two host adapters and
external Git changes. Therefore invalidation lives in the standalone Node core,
not in Emacs hooks, and coalesces editor saves, filesystem operations, Wiki page
operations, and Git refreshes into one incremental pipeline.

## Note and tag search

org-roam completion returns a stable node object while formatting title,
aliases, tags, and file context only for display. Noema keeps the same identity
rule: a completion choice resolves to a page ID/file, never back from a display
label. SQLite FTS5 and Unicode trigram indexes add ranked full-text and
structured filters (`tag:`, `title:`, `repo:`, `namespace:`, `is:`) needed by a
large Markdown workspace.

Current-document metadata is intentionally different from search candidates:
the live CodeMirror document is the source of truth for selected tags; the DB
only supplies autocomplete candidates. A tag action records explicit add/remove
identities, applies them to the latest editor document, preserves untouched
spelling/order/quoting/plugin fields, then uses the normal save transaction.
The save result is what invalidates the DB. There is no tag-specific file writer
and no editor reload from a server response.

## Graph

org-roam-ui's main strength is not a particular screenshot; it is one behavior
model shared by 2D and 3D force-graph renderers. Noema adopts that boundary:

- one graph payload with stable page/tag keys;
- one Global/Local scope state and one 1–3 hop neighborhood traversal;
- one search/filter, group, follow/focus, hover-neighbor highlight, right-click
  local graph, double-click open, and persisted-settings implementation;
- thin `force-graph` 2D and `3d-force-graph` adapters for dimension-specific
  drawing, camera movement, and sizing;
- the editor's current-note graph uses the same 2D runtime while building its
  bounded local payload from the live, possibly unsaved Markdown document;
- bounded projection at 10,000 nodes/25,000 edges, with the home preview capped
  further and the WebGL 3D renderer loaded only on the full Graph page.

This deliberately avoids the previous architecture in which the homepage had
an unrelated Canvas interaction system and 3D separately copied org-roam-ui
behavior. Shared settings without shared transitions are not considered a
shared graph model.

## Deliberate differences

- Noema indexes Markdown and multiple Git repositories; org-roam indexes Org
  buffers under one Emacs configuration.
- Noema's physical path, privacy partition, repository, and logical namespace
  remain separate dimensions.
- The desktop app cannot depend on Emacs, org-roam, or org-roam-ui services.
- Noema retains its own FTS/trigram search, Git synchronization, bounded graph
  projection, and server-reader privacy boundary where they are stronger or
  required by the product.

Adapted graph source carries GPL-3.0 attribution in `NOTICE` and in the relevant
source files. The database/search review transfers architecture, not source
code.
