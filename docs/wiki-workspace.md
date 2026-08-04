# Noema Wiki workspace

Noema's default workspace is `~/Documents/Noema` (`NOEMA_ROOT` may override it).
Configuration lives in `~/.config/noema/config.json`; themes remain bundled with
the application.

## Layouts

`workspace.layout` is deliberately explicit:

- `legacy` keeps the existing single-repository note tree working. Noema never
  moves or initializes current content while this layout is active.
- `wiki` indexes only direct Git repository children of `public/` and
  `private/`.

In Wiki layout the workspace is:

```text
~/Documents/Noema/
├── .envrc
├── flake.nix
├── Makefile
├── .noema/
│   └── wiki.db
├── public/
│   ├── math/.git/
│   └── philosophy/.git/
└── private/
    ├── daily/.git/
    └── project/.git/
```

The root toolchain files are user-owned. The desktop app does not require
direnv. When the root `.envrc` is already authorized, Noema exports it without
shell evaluation and passes the resulting environment only to tool
subprocesses, including local Jupyter kernels and LaTeX compilation.

A direct child directory without `.git` metadata is reported but never indexed
or initialized automatically.

`wiki.db` is a disposable, local SQLite/WAL projection of Git-owned Markdown.
It stores page identity, titles, aliases, tags, links, backlinks, dependencies,
diagnostics, and Unicode/trigram full-text indexes. It is never committed. The
legacy `roam.db` and `roam-db.json` are neither read nor written in either
layout and can be removed. Both the desktop and Emacs adapters use the same
`wiki.db`; Emacs does not maintain a second database.

The database, completion, and graph boundaries were also reviewed against
org-roam and org-roam-ui. Noema adopts stable node identity, normalized
relationship tables, content-aware incremental indexing, and completion items
that keep identity separate from display text. Its 2D home graph and 3D graph
page use the same scope/search/follow/selection runtime and differ only in their
force-graph renderer. The detailed adoption and rejection matrix is in
`docs/architecture/org-roam-study.md`.

Attachments remain physical files and only their metadata is inventoried; their
contents are not copied into SQLite. Typst files remain editable in Noema but
are ordinary files rather than Wiki pages.

## Index maintenance

The first index, a schema change, repository topology or identity changes, an
unreachable Git HEAD watermark, and the weekly self-heal use an atomic full
rebuild. Ordinary file changes are coalesced and applied incrementally. Link
resolution is recomputed from the complete page snapshot, so adding or moving a
target also repairs links in otherwise unchanged source notes.

The database records each repository identity, last indexed HEAD, scan time,
last full and incremental runs, and the reason for the selected maintenance
mode. No index operation creates commits, tags, branches, or other Git refs.
Git maintenance is a separate service: physical file changes only mark a Wiki
repository dirty, and the startup/periodic service later checkpoints and
synchronizes that batch.

Every first-party mutation that can affect the projection—note saves and
creation, page move/copy/merge/delete/restore, metadata and tag edits, managed
filesystem actions, assets, slide mirrors, and persisted Jupyter cell
artifacts—invalidates the affected paths and schedules an incremental DB
refresh. A successful Git refresh supplies its changed paths to the same
incremental pipeline. Ten percent of successful Git refreshes select a full
atomic rebuild instead, providing probabilistic self-healing for missed
external changes; set `NOEMA_WIKI_FULL_REFRESH_PROBABILITY` to a value from `0`
to `1` to tune that diagnostic policy.

## Links and identity

Wiki pages support `[[Page]]` and `[[Page|Label]]`. Completion rewrites a known
page to `[[roam://id|Label]]`, so moves and renames do not break the link. A
title-only link first prefers a unique page in the source repository, then
falls back to the global index. Duplicate matches are shown with partition,
repository, and repository-relative path. Missing targets open the New Page
workbench. `roam://id` remains the stable exact-link form.

File location is not identity. New page profiles configure partition,
repository, directory, filename pattern, and note kind.

## Namespaces

Namespaces are logical knowledge domains and are independent of physical
folders. Every repository provides a default namespace using its directory
name. A repository can declare a durable display name and aliases in
`noema.toml`:

```toml
schema = 1
repository_id = "019…"
namespace = "Mathematics"
namespace_aliases = ["Math", "数学"]
```

A page can override the repository default without moving the Markdown file:

```text
#+begin meta
id: 019…
title: Tensor Product
namespace: Research/Quantum
#+end meta
```

Wiki targets have four precision levels:

- `[[Tensor Product]]` prefers one match in the source repository, then the
  global index.
- `[[Mathematics:Tensor Product]]` selects a logical namespace or alias.
- `[[public/Mathematics:Tensor Product]]` includes the privacy partition and
  is fully qualified.
- `[[roam://019…|Tensor Product]]` is the exact stable page identity emitted
  by completion.

Colon is reserved as the namespace separator. Slash forms nested namespaces;
it does not imply a physical folder. SQLite stores the namespace,
fully-qualified namespace, and source (`repository` or `page`) separately and
can filter large indexes without scanning Markdown. Moving a page preserves
its logical namespace, while copying may choose a new one in the workbench.
The Namespaces view can rename a whole domain in place; Noema records the old
name in `namespace_aliases`, so existing qualified links continue to resolve.

## Git collaboration cadence

Noema creates a device work branch and automatically performs the
checkpoint/fetch/merge/push cycle in Wiki layout. Saving only marks the affected
repository dirty; it does not create a Git commit per edit. All repositories
synchronize shortly after startup and then roughly every six hours, with up to
ten minutes of jitter so multiple devices do not all contact the remote at the
same instant. Work is serialized per repository and an offline/error result is
retried after one minute. During an orderly App shutdown, dirty repositories
receive a local checkpoint; the next startup/periodic pass performs the network
sync. `NOEMA_WIKI_AUTO_SYNC=0` is the diagnostic override for disabling this
policy.

**Local commit** and **Commit & sync** remain available for an immediate manual
checkpoint or synchronization. Git author configuration is preserved; Noema
uses a local fallback identity only when the repository has no configured
author. Legacy layout does not opt into the multi-repository automatic policy.

Conflicts are isolated in a disposable integration worktree and resolved in
the embedded three-way merge editor. The user's primary working tree stays on
the device branch and is never left in a partially merged state. Automatic
retry pauses for a conflicted repository until the user resolves or aborts the
merge from the repository view.
The embedded ungit sidecar provides the full visual staging, commit, branch,
and history workflow for advanced maintenance without sending users to a
terminal or another application.

## Upstream design references

The workspace boundaries, page lifecycle, tags, assets, navigation, search,
history, and storage-adapter separation were reviewed against Wiki.js. The wide
two-sidebar information architecture and responsive drawer behavior were
reviewed against MediaWiki's Vector skin. Noema keeps its existing CM6 editor
and physical Git repositories rather than importing either upstream runtime.
Exact third-party components used by the product are declared dependencies,
including ungit for visual Git maintenance and MisMerge for three-way conflict
resolution.

## Publishing boundary

The publisher scans only repositories below `public/` in Wiki layout. It never
walks `private/`. A public-repository page with `private: true`, `hidden: true`,
or another existing no-export marker is omitted.

## Deferred Legacy migration

The current `~/Documents/Noema` tree stays in Legacy layout until migration is
explicitly requested. The intended future split is one Git repository per
top-level directory:

- public: `Philosophy`, `QC`, `books`, `learn`, `math`, `papers`, `references`
- private: `daily`, `project`, `scratch`

This document records the destination policy only. Noema does not move those
directories, create their repositories, change remotes, or publish them as part
of the application upgrade.
