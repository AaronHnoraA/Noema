# Noema LaTeX Export — Style Contract

This is the contract for converting an Noema note (Markdown source) into a
LaTeX **body** for CMD+P export. Noema first applies private-syntax and
semantic preprocessing, Pandoc converts standard Markdown, and the selected
agent then performs gated structural and typographic polish.

## Absolute rules

1. **Never change the prose.** Do not add, remove, reorder, translate, or reword
   any sentence, word, number, symbol, or citation the author wrote. You only
   change *formatting/markup*, never *content*. When unsure, keep the source
   text verbatim.
2. **The output must compile.** The host wraps your body in a template and runs
   the LaTeX compiler. Fix anything that would not compile (unbalanced braces,
   undefined environments, stray Markdown that leaked through), but only by
   correcting markup — not by deleting content.
3. **Do not touch the preamble or macros.** Title, date, author fields, the
   shared `aaronnote-macros.sty`, and `\documentclass` are filled by
   the host. Do not redefine macros or add packages inside the body. Emit body
   content only (what goes between `\begin{document}` … `\end{document}`).
4. **Preserve math verbatim.** Keep inline math `\(...\)` and display math
   `\[...\]` (and `$$...$$` → `\[...\]`) exactly as written. Never escape
   backslashes inside math. Macros such as `\rank`, `\ket`, `\abs` are provided
   globally — use them, never redefine them.

## Construct mapping

| Noema / Markdown | LaTeX |
|---|---|
| `# .. ######` | `\section` / `\subsection` / `\subsubsection` / `\paragraph` |
| `- item` / `* item` / `+ item` | `itemize` (indent = nesting) |
| `1. item` / `1) item` / `(a) item` | native `enumerate` with matching labels |
| `> quote` | `quote` |
| ` ```lang ` fenced code | `verbatim` |
| `**x**` / `__x__` | `\textbf{x}` |
| `*x*` / `_x_` | `\emph{x}` |
| `` `x` `` | `\texttt{x}` |
| `[t](url)` / `![t](url)` | `\href{url}{t}` |
| tables / footnotes / definitions / task lists / strikeout | Pandoc-native academic LaTeX |
| `@@latexmk(name)` | typed, placement-validated LaTeX mark |
| `@@cite(namespace) [key; ...] {locator: ...}` | resolved `\\cite` plus matching bibliography entries; unresolved/partial groups are export errors |
| `@@revision(style) [original] {advice: "..."; reason: "..."}` | always-visible `\\aaronrevision{original}{advice}{reason}` until accepted or kept |
| `@@todo(...) [...]{...}` | **dropped** (todos never appear in exports) |
| `#+begin meta ... #+end meta` | consumed for title/date; not emitted |

## Block environments (`#+begin kind ... #+end kind`)

Map `kind` to the theorem-like environment of the same name available in the
active template:

- `theorem`, `lemma`, `proposition`, `corollary`, `definition`/`define`,
  `remark`, `example` → `\begin{<env>}[optional title] ... \end{<env>}`.
- `proof` → `\begin{proof}[Proof (…)] ... \end{proof}`. A `=>` / `<=` title
  becomes `Proof (\(\Rightarrow\))` / `Proof (\(\Leftarrow\))`.
- Comment-like blocks (`comment`, `summary`, `note`, `important`, `warning`,
  `attention`) → `remark` with the kind/title as the label.
- Unknown kinds → `\paragraph{kind}` fallback (never drop the content).

The **assignment** template additionally offers `prob`, `sol`, `ans`, `pf`.
Prefer those there when the source clearly marks problems/solutions, but only if
it does not change any text.

## Escaping (prose only, never math)

Escape `# $ % & _ { } ^ ~` and a literal backslash in ordinary prose. Do **not**
escape inside `\(...\)`, `\[...\]`, or `verbatim`. Keep CJK text as-is (templates
load CJK support).

## Available theorem environments per template

Read the chosen template file (passed to you) to see exactly which
`\newtheorem` environments and macros exist before using them. Do not invent an
environment the template does not define.

## Restrained academic typesetting

This agent is a **format converter and validator, not an author or copy editor**.
Academic polish may change LaTeX markup only. It must never change, add, remove,
translate, summarize, “clarify”, or reorder text, numbers, symbols, formulas, or
citations. If polish conflicts with fidelity, preserve the source and skip the
polish.

Within that hard boundary, aim for a clean short-paper or lecture-note style:

- keep section hierarchy, theorem/proof labels, lists, quotations, and displayed
  mathematics visually consistent;
- remove accidental spacing artifacts and avoid gratuitous manual vertical
  space, repeated hard breaks, decorative headings, boxes, colours, or rules;
- prefer semantic environments over visual hacks, but never invent an
  environment or alter the author's logical structure;
- watch for overfull lines, headings stranded at a page bottom, awkward paragraph
  breaks, and a title that overwhelms or clips its title area; correct these only
  with body-level, template-compatible markup;
- preserve intentional `@@latexmk(newline)` breaks, while treating Markdown blank lines
  as paragraph boundaries rather than requests for extra vertical whitespace.

Do not manufacture an abstract, keywords, numbering, citations, captions,
conclusions, transitions, or any other content absent from the source.

Explicit source title metadata is authoritative. Otherwise synthesize a title
from the semantic intent of the source filename/name, the work type implied by
the template, and exactly one dominant subject from the content. Do not blindly
copy internal slugs such as `assg`, `hw`, or `q1`, and do not replace them with a
multi-topic synopsis. Preserve a source name that is already presentation-ready.
The result is at most 42 characters and normally at most 6 words.

## Typed LaTeX marks

The shared registry drives parser validation, editor widgets, generic completion,
and individual snippets:

| Mark | Intent | Placement |
|---|---|---|
| `newline` | explicit line break | between visible inline content |
| `nbsp` | non-breaking space | between visible inline content |
| `allowbreak` | safe wrap opportunity | between visible inline content |
| `noindent` | suppress paragraph indent | paragraph prefix |
| `newpage` | start a page | alone on a line |
| `clearpage` | flush floats and start a page | alone on a line |
| `nopagebreak` | keep adjacent blocks together | alone on a line |
| `keepnext` | reserve space for the next block | alone on a line |
| `appendix` | switch to appendix numbering | alone, at most once |

Unknown names and invalid placement are export errors; marks are never silently
dropped.

## Citation contract

The full live document supplies meta context even when only a selection or
heading subtree is exported. `bib:` may name a local directory or one concrete
`.bib` file. A short namespace is accepted only when its basename is unique;
otherwise the full namespace is required. Every item in a citation group must
resolve before conversion. Never filter an unknown item out of a mixed group,
invent a placeholder citation, or emit a bibliography entry from code, math,
HTML comments, links, hidden source blocks, or private planning commands.
`prefix`, `locator`/`page`/`pages`, and `suffix` are visible author content and
must survive in order.

## Pipeline reminder

Pandoc and the host verifier come first. The mechanical document is staged and
compiled before any agent is considered. In assisted mode a compiling draft may
receive exactly one gated polish attempt. A timeout, opaque-payload fidelity
failure, or non-compiling result ends the export without replacing the previous
files and is never silently reported as a polished success. Missing or malformed
review evidence is retained as an explicit warning, but does not discard a body
that otherwise preserves critical payloads and compiles. Multiple attempts are
reserved for a concrete mechanical compile failure with compiler feedback. Start
from `draft.tex` and `source.md`, make the **smallest**
justified edit, and write a fresh `review.json`. The host rejects changes to
opaque citation/code/resource payloads. Semantic
list/environment changes, paragraph wrappers, mathematical layout environments,
and justified break opportunities remain available to the agent; their content
constraints live in the prompt/review contract rather than an exact-structure
host comparison. Final `.tex`/PDF/shared
files are committed only after two compiler passes and log linting succeed. See
`agents/latex-export/AGENTS.md` for the repair contract and the (rare) tool
maintenance workflow.

Templates may declare reusable support files through `sharedFiles` in their
`aaronnote-template` header. The host compares file contents and atomically
copies a dependency beside the exported `.tex` only when it is missing or
outdated. Large classes and shared macro libraries belong there rather than in
`filecontents`; bibliography output deliberately remains in the document body
so citation data cannot drift from the exported note.

The embedded `% aaronnote-template: {...}` header supports `documentRole`,
`sharedFiles`, and typed `vars` with `input`, `options`, `required`,
`placeholder`, `description`, `group`, and `escape`. Invalid engines, duplicate
or reserved variables, unsafe shared paths, missing required values, and unknown
template placeholders fail explicitly.
