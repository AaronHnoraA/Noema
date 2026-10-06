# Adjustable Media source adapted for Noema

`v2.ts`, `model.ts`, `geometry.ts`, and `line-context.ts` are adapted from
[Yi-luo-hua/obsidian-adjustable-media](https://github.com/Yi-luo-hua/obsidian-adjustable-media)
at commit `d5c8785c37c39f9e3636ab1b50d7a251a0a3cd65` (MIT license in `LICENSE`).
Only import paths changed in the vendored files. Noema currently imports
`geometry.ts` for row drag/drop and proportional resizing. The `v2.ts`,
`model.ts`, and `line-context.ts` files are retained as audited upstream
reference code; their `<!-- vml ... -->` format is not enabled in Noema.
Noema's editor keeps native Markdown images and its existing layout attributes
as the source of truth.
