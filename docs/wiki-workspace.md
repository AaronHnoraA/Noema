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

## Links and identity

Wiki pages support `[[Page]]` and `[[Page|Label]]`. Titles and aliases resolve
globally. A unique match opens directly; duplicate matches are shown with
partition, repository, and repository-relative path. Missing targets open the
New Page workbench. `roam://id` remains the stable exact-link form.

File location is not identity. New page profiles configure partition,
repository, directory, filename pattern, and note kind.

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
