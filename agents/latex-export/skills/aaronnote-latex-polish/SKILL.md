---
name: aaronnote-latex-polish
description: Structurally polish a Pandoc-generated Noema LaTeX body while preserving all public source text exactly. Use for Noema export review involving ambiguous lists such as (a)/(b), theorem/problem/solution structure, headings, citations, math, code, and explicit LaTeX marks.
---

# Noema LaTeX Polish

Treat `source.md` as immutable content and `draft.tex` as the authoritative base.

## Workflow

1. Read `source.md`, `draft.tex`, `template.tex`, and `style.md` completely.
2. Read `polish-candidates.json` and build a structural outline before editing.
3. Make only markup changes justified by repeated, local, unambiguous structure.
4. Compare the final body against the source from beginning to end.
5. Answer every candidate id in `review.json`; omission is surfaced as an
   explicit audit warning and makes the result less observable.

Use this shape:

```json
{"decisions":[{"id":"alpha-enumeration","kind":"list","action":"applied|kept","reason":"concrete evidence"}]}
```

## Context-sensitive structures

Convert `(a)/(b)`, `a)/b)`, or roman labels only when at least two consecutive
items share a level and function as an actual list. Keep inline references such
as “part (a)”, equation labels, coordinates, isolated labels, and quoted text.
Pandoc already handles well-formed fancy lists; do not rewrite them again.

Use problem/solution/proof environments only when the source explicitly carries
that role and the template defines the environment. Never infer new assertions,
labels, numbering, captions, transitions, or section titles.

## Fidelity gate

Reject your own edit if it changes any visible word, number, punctuation mark,
math token, code token, citation key/locator, order, or explicit `@@latexmk`
intent. Moving unchanged text into a semantic environment is allowed; rewriting
it is not. When uncertain, keep the Pandoc draft and record `action: kept`.
