# Noema Wiki workspace

Noema's default workspace is `~/Documents/Noema` (`NOEMA_ROOT` may override it).
Configuration lives in `~/.config/noema/config.json`; renderer themes remain
bundled with the Emacs-hosted Web assets.

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

The root toolchain files are user-owned. Noema does not require direnv. When
the root `.envrc` is already authorized, the Emacs-started host exports it
without shell evaluation and passes the resulting environment only to tool
subprocesses, including local Jupyter kernels and LaTeX compilation.

A direct child directory without `.git` metadata is reported but never indexed
or initialized automatically.

`wiki.db` is a disposable, local SQLite/WAL projection of Git-owned Markdown.
It stores page identity, titles, aliases, tags, links, backlinks, dependencies,
diagnostics, and Unicode/trigram full-text indexes. It is never committed. The
legacy `roam.db` and `roam-db.json` are neither read nor written in either
layout and can be removed. Both the desktop and Emacs adapters use the same
`wiki.db`; the Emacs-hosted renderer does not maintain a second database.

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
workbench in an Emacs-hosted window. The form pre-fills the source repository,
directory, and namespace; an explicitly qualified target such as
`[[Research:Page]]` or `[[public/Research:Page]]` pre-fills that namespace and
requires a repository in the requested partition. The author can change the
repository, namespace, directory, and filename before creating the page.
After creation, the clicked source link is upgraded to `[[roam://id|Label]]`
if its original source text is still present in the source editor. An existing
page or alias in the chosen repository and namespace can be selected instead.
`roam://id` remains the stable exact-link form.

A colon is read as a namespace separator only when a page answers to that
reading. `[[Chapter 1: Scope]]` and `[[定理：存在性]]` therefore link the page
with that title when no namespace `Chapter 1` or `定理` holds a matching page.
A redirect page answers for its ID only; its old title resolves through the
alias the merge left on the surviving page.

In the editor, a link is resolved against the note index by identity first
(ID, key, title, alias, path) and then by location: the path with or without
its note extension, or either as a whole trailing run of directories, so
`topic/page` finds `…/topic/page.md` (`shared/note-refs.mjs`). A reference is
never matched inside a path segment or a title, and a tag never names a page:
`[x](src)` or `roam://set` resolves to nothing unless a note answers to
exactly that, instead of opening the first note whose path or tags happened
to contain the text. A file reported under two spellings is the same note when
one path is the other's whole tail; two notes that only share a file name
(`README.md` in two namespaces) are never treated as one.

The `date` a new page or note is stamped with, the `{date}` filename pattern
and the Agenda's Today and Overdue filters use the author's calendar date,
not the UTC date.

Unlinked-mention detection (the link review tool, the Knowledge Dock and the
Server reader) requires a word boundary around Latin-script titles. Han and
kana titles match inside running text, because those scripts have no spaces
to bound a word.

## Search

Structured Knowledge queries run against `wiki.db`. A query combines free text
with `field:value` filters; a leading `-` negates a filter and quotes keep a
phrase together.

| Filter | Matches |
| --- | --- |
| `title:` (`intitle:`) | title or alias |
| `tag:` (`category:`) | tag |
| `repo:` (`repository:`), `namespace:`, `path:`, `kind:` | location and page kind |
| `linksto:` | a page linking to the given ID or title |
| `is:orphan`, `is:missing` | no resolved links in or out; has an unresolved link |
| `after:` (`since:`), `before:` (`until:`) | modification time |
| `created:` | the period of the page's `date` metadata |

`after:` and `before:` take a calendar date (`2026`, `2026-10`, `2026-10-09`)
or an age (`7d`, `2w`, `3m`, `1y`). The bound is the local start of that day:
`after:2026-10-09` includes the 9th, `before:2026-10-09` ends with the 8th.
`created:` takes the same forms and names a period instead of a bound:
`created:2026-10` is pages dated that month, `created:7d` pages dated within
the last week. A page without a `date` matches no `created:` filter.

Free text uses the Unicode index, or the trigram index when it contains CJK.
A trigram index cannot answer a term shorter than three characters, so a query
with a one- or two-character CJK term (`群论`) scans the indexed title,
aliases, tags and body instead and cuts the excerpt around the first hit.

In the Emacs editor, each Roam title stays one continuous text link with a
single node marker at its start, even when spelling annotations divide the
editor's internal spans. A filled
diamond identifies a stable ID target; an outlined diamond identifies a title
target that still resolves through the Wiki index. Hovering opens a node
preview, while moving the caret into the link reveals its original Markdown
source for editing. The visual treatment does not alter the stored link text.

The editor's **Review suggested Wiki links** tool scans the current page only
when invoked. It proposes title and alias matches in plain prose one at a
time, lists repository and namespace for ambiguous matches, and applies only
approved links in one undoable edit. A public page never suggests a private
target. It skips existing links, metadata, headings, code, formulas, and URLs.
There is no automatic link insertion on save or render.

File location is not identity. New page profiles configure partition,
repository, directory, filename pattern, and note kind.

Page management is available from the editor's **Manage this Wiki page** tool.
Rename and move preserve the stable page ID; an old title becomes an alias.
Copy creates a new ID. Merge previews both Markdown bodies, appends the
duplicate body to the survivor, archives the original duplicate Markdown,
and leaves a redirect at the duplicate ID. Private-to-public moves and copies
require an explicit confirmation because the full file enters a public Git
repository even if the page remains hidden from the published catalog.
Deletion lists backlinks and keeps a Wiki Trash record so the page and its
owned assets can be restored to their original paths and ID. Relative
dependencies outside the page-owned asset directories block relocation until
the author fixes them.
A title, ID, kind or tag is one line of text; a value with a line break is
rejected, since it would start another metadata field. A move that fails part
way (an occupied asset directory, a filesystem error) is undone and leaves the
page and its assets where they were; the operation journal records
`rolled-back`. Copying requires the page's ID to live in its `#+begin meta`
block, and tag edits report pages whose tags live in YAML front matter as
`skipped` instead of changed.
Git history exposes committed changes and the current uncommitted diff.
Restoring a commit warns when it would overwrite current working changes and
requires an explicit typed confirmation in that case. Moving between Git
repositories preserves the page ID, but the destination repository does not
inherit the source repository's commit history.

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

This manifest makes the directory a Wiki repository only. It is not a
research Project: a vault's `.noema` documents belong to the nearest manifest
with a `[project]` table, usually one per research topic inside the vault (see
README, D-038). Adding `[project]` to the repository manifest makes the whole
repository one Project when that is really wanted.

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
synchronize shortly after startup and then roughly once per day, with up to
ten minutes of jitter so multiple devices do not all contact the remote at the
same instant. Work is serialized per repository and an offline/error result is
reported once for the batch. Busy repositories retry shortly, transient network
failures use bounded exponential backoff, and authentication/configuration
failures pause with an actionable repository status. During an orderly App shutdown, dirty repositories
receive a local checkpoint; the next startup/periodic pass performs the network
sync. `NOEMA_WIKI_AUTO_SYNC=0` is the diagnostic override for disabling this
policy.

**Local commit** and **Commit & sync** remain available for an immediate manual
checkpoint or synchronization. Git author configuration is preserved; Noema
uses a local fallback identity only when the repository has no configured
author. Legacy layout does not opt into the multi-repository automatic policy.

Conflicts are isolated in a disposable integration worktree and resolved in
the embedded three-way merge editor. The user's primary working tree stays on
the device branch and is never left in a partially merged state. Local editing
may continue while a conflict is open; Noema checkpoints those later edits and
includes them before publishing the resolved result. Automatic retry pauses for
a conflicted repository until the user resolves or aborts the merge from the
repository view. Unexpected files in Noema-owned integration worktrees are
quarantined below `.noema/recovery/git/` before the worktree is rebuilt; recovery
batches are retained for 30 days.
The embedded ungit sidecar provides the full visual staging, commit, branch,
and history workflow for advanced maintenance without sending users to a
terminal or another application.

## Upstream design references

The workspace boundaries, page lifecycle, tags, assets, navigation, search,
history, and storage-adapter separation were reviewed against Wiki.js. The wide
two-sidebar information architecture and responsive drawer behavior were
reviewed against MediaWiki's Vector skin. Noema keeps its existing CM6 editor
and physical Git repositories rather than importing either upstream runtime.
Alexandrie was compared line by line for its node tree, search and editor.
Noema keeps Markdown files in Git as the only source of truth, so Alexandrie's
database-owned node table, numeric `#id` links, per-user permissions and
object storage were not adopted. Three things were: its pre-indexed collection
(one pass builds the title, ID and file maps that every link resolution
reads), its excerpt cut around the first match for searches the full-text
index cannot serve, and its date-range search filter, expressed here as
`after:`/`before:` query fields rather than a filter panel.
Its date filter can also be turned from "modified" to "created"; here that is
the `created:` field, read from the `date` a page's metadata already carries
rather than from a database timestamp. Its editor shows a numeric `#id` link
under the target document's current name; Noema does the same for a stable
link written without a label, `[[roam://<id>]]`, and marks a stable ID that no
page answers to. The source keeps the ID and shows it while the selection
touches the link, and title links are left to the index to resolve.
The follow-up [MediaWiki × Roam interaction audit](mediawiki-roam-ux-audit-2026-10.md)
tracks the link-to-page creation flow, multi-repository choices, page actions,
and history semantics against MediaWiki's source and user-facing behavior.
Exact third-party components used by the product are declared dependencies,
including ungit for visual Git maintenance and MisMerge for three-way conflict
resolution.

## Publishing boundary

The publisher scans only repositories below `public/` in Wiki layout. It never
walks `private/`. A public-repository page with `private: true`, `hidden: true`,
or another existing no-export marker is omitted.

### Reading order and pinned pages

The Server reader, and only it, offers a reading order. A page's previous and
next page are its neighbours among the public pages of the same repository
folder; redirects and hidden pages are neither offered nor passed through.
Order comes from the page's own metadata, so it travels with the Markdown:

```text
#+begin meta
order: 2
pinned: true
#+end meta
```

Pages with an `order` come first, by that number; the rest follow by title in
natural order (`Lecture 2` before `Lecture 10`). `pinned: true` puts the page
on a Pinned shelf at the top of the public Wiki home. Both fields are read
when the public catalog is built. The local index, its cache and the Emacs
surfaces ignore them, where the same pages are reached through Emacs.

## Deferred Legacy migration

The current `~/Documents/Noema` tree stays in Legacy layout until migration is
explicitly requested. The intended future split is one Git repository per
top-level directory:

- public: `Philosophy`, `QC`, `books`, `learn`, `math`, `papers`, `references`
- private: `daily`, `project`, `scratch`

This document records the destination policy only. Noema does not move those
directories, create their repositories, change remotes, or publish them as part
of the application upgrade.
