# Zditor interaction study for Noema

Reviewed 2026-07-18:

- <https://docs.zditor.com/>
- <https://www.zditor.com/roadmap>
- <https://github.com/zditor/zditor-docs> at `af200d233fd738a82d5a11939baf9e7815c8fa10`

The documentation repository did not expose a LICENSE/COPYING file at the
reviewed commit. Noema therefore uses the public documentation only as a
behaviour and UX reference. No Zditor source code is copied.

## Adopted in Noema-native form

- Current-document properties, implemented primarily through
  `#+begin meta`; YAML frontmatter remains a small source-oriented Markdown
  compatibility layer.
- Native review suggestions through `@@revision`, with accept/keep/edit and
  visible HTML/LaTeX export.
- Block drag/reorder and object-aware controls.
- Local/workspace graph scope, shared 2D/3D force-graph behavior, search, group
  filtering, selection-neighbour emphasis, scale caps, and lazy 3D loading.
- Matching authoring snippets for metadata, review, superscript, subscript and
  footnotes.

## Deliberately excluded

- PDF annotation, Excalidraw/canvas authoring, mobile editing.
- SuperTag/database aggregation and ECharts chart generation.
- Dollar-delimited math and per-keystroke smart-symbol replacement.
- Complex typed YAML property objects. Noema Roam metadata remains
  `org-env(meta)`-first.

## Performance contract

New editor decorations are viewport-local or bounded. Metadata is capped at
256 KiB/256 fields, block moves at 1 MiB/20,000 lines, and workspace graph
drawing at 10,000 nodes/25,000 edges from an index of at most 50,000 searchable
nodes. Graph code/data/workers load only when the panel is opened and workspace
scope is selected.
