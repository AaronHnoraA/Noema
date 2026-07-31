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
legacy `roam.db` is neither read nor written in Wiki layout and can be removed.
Attachments remain physical files and only their metadata is inventoried; their
contents are not copied into SQLite. Typst files remain editable in Noema but
are ordinary files rather than Wiki pages.

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

Noema creates a device work branch and performs the checkpoint/fetch/merge/push
cycle at startup, on explicit **Sync now**, and approximately every six hours
with jitter. Editing a note does not create a Git commit. A normal application
shutdown creates one best-effort checkpoint for dirty repositories. Git author
configuration is preserved; Noema uses a local fallback identity only when the
repository has no configured author.

Conflicts are isolated in a disposable integration worktree and resolved in
the embedded three-way merge editor. The user's primary working tree stays on
the device branch and is never left in a partially merged state.
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
