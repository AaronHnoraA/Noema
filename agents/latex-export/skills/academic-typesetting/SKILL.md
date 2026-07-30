---
name: academic-typesetting
description: Audit and refine restrained academic LaTeX typography without changing content. Use for Noema exports requiring template-aware spacing, page flow, lists, tables, figures, theorem/proof presentation, overfull-line prevention, and title fit.
---

# Academic Typesetting

Apply restrained academic typography after structural polish.

## Audit order

1. Confirm every environment and command exists in `template.tex` or its shared support files.
2. Check heading hierarchy, theorem/proof rhythm, list nesting, tables, figures, footnotes, and displayed math.
3. Check likely overfull lines, orphan headings, widow lines, float placement, and title fit.
4. Prefer semantic environments and template defaults over manual spacing.
5. Re-read the entire body and remove any cosmetic edit that lacks evidence.

## Allowed refinements

- Select a template-defined semantic environment.
- Normalize structurally equivalent list markup.
- Add conservative break opportunities around long technical material.
- Keep a heading with the following block when clear page-flow evidence exists.
- Preserve author-supplied `@@latexmk` page/line intentions.

## Forbidden refinements

- Do not add packages, macros, prose, captions, headings, abstracts, keywords, numbering, colour, boxes, rules, or decorative spacing.
- Do not add `\vspace`, `\hspace`, `\sloppy`, arbitrary font-size commands, or raw layout hacks.
- Do not introduce page breaks without source intent or concrete layout evidence.
- Do not edit wording to improve style; this is typesetting, not copy-editing.

If the draft is already clean, make no edit and say so in `review.json`.
