# TikZ Editor core

Vendored from [DominikPeters/tikz-editor](https://github.com/DominikPeters/tikz-editor),
commit `be197d85e278bf76c5fc052931b7902942e274e7` (v0.5.2), under MIT.

`core/src` and `lezer-tikz/src` are the upstream source. The `dist` directories
contain the corresponding built JavaScript and declarations, without source
maps or stale source-map references. The package manifests change only the unpublished monorepo dependency
on `@tikz-editor/lezer-tikz` to a local `file:` dependency. Keep the source,
build output, and commit pin together when updating.
