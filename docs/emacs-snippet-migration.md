# Snippet catalog and upstream synchronization

Noema and Emacs share the YAS files under `snippets/`. Noema reads those
files through the server; it does not maintain a second JSON catalog and does
not contact an LSP or an upstream service at runtime.

## Sources and precedence

The catalog contains manually maintained snippets plus generated,
KaTeX-compatible math entries from:

- LaTeX Workshop `57f9e8d0306ea0c7419290a2b62ee0cec3c31041`
- Overleaf `28ad3b03b71cb4311decdcb55c36b33ec10d72db`

Exact revisions, source-file hashes, licenses, generated-file hashes, and
import counts are recorded in `snippets/tex-mode/generated/.manifest.json`.
Generated content is restricted to math commands, math environments, styles,
and LaTeX Workshop's `@` shortcuts. Project-only completion such as package,
class, section, figure, bibliography, and file-path suggestions is excluded.

Duplicate keys use this precedence:

1. Personal or manually maintained YAS
2. Current-note commands and configured KaTeX macros
3. Noema built-ins
4. LaTeX Workshop generated entries
5. Overleaf generated entries

When a local expansion wins, compatible upstream frequency weights and aliases
are still merged into its ranking metadata.

## Synchronizing

Normal verification needs no upstream checkout:

```sh
npm run snippets:sync
```

To update the pinned sources, first update the revisions in
`scripts/sync-math-snippets.mjs`, then regenerate from local git checkouts:

```sh
node scripts/sync-math-snippets.mjs --write \
  --latex-workshop-git /path/to/LaTeX-Workshop \
  --overleaf-git /path/to/overleaf
npm run snippets:sync
```

The writer only owns `snippets/tex-mode/generated/{latex-workshop,overleaf}`.
It never rewrites personal snippets. Review the manifest count and diff before
updating a pinned revision.

## Portable YAS subset

Noema supports ordinary text, `$0`, numeric fields, defaults, nested
fields, mirrors, choices, multiline indentation, and the following selected
text form:

```snippet
\hat{${1:`(or yas-selected-text "x")`}}$0
```

The generator converts `TM_SELECTED_TEXT` and TextMate choices into that
portable YAS representation. Browser code never evaluates Emacs Lisp. A YAS
file with arbitrary backtick Lisp, `$()` evaluation, or an unsupported
TextMate variable remains usable in Emacs but is marked browser-incompatible
and omitted from Noema completion.

Generated metadata uses YAS's native `uuid` and `contributor` headers. The
URL-encoded contributor suffix is decoded only by Noema, so YAS loads the
same files without unknown-directive warnings:

```snippet
# uuid: latex-workshop:@a
# contributor: Noema provider=latex-workshop&priority=180&weight=1.2&context=math-at&description=alpha
```

Valid contexts are `prose`, `org-meta`, `markdown`, `math`, `math-command`, and
`math-at`.

## Performance contract

- No runtime network or per-keystroke filesystem access.
- Completion recognition is cursor-local; document statistics are rebuilt in
  cancellable 16 KiB chunks with at most 8 ms of work per idle slice.
- Candidate display is capped at ten, local ranking history at 512 entries,
  and all local-history writes are debounced.
- The 5 MB fixture in `tests/large-document-perf.test.ts` remains the regression
  guard against accidental whole-document input paths.
