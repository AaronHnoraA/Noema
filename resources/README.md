# Shared resources

Noema is the source of truth for the static assets it consumes:

- `snippets/markdown-mode/` and `snippets/tex-mode/`: YASnippet catalogs
  shared by Noema and Emacs
- `templates/noema/`, `templates/latex/`, and `templates/tex/`: note and
  LaTeX templates shared by Noema and Emacs
- `katex-macros/`: global TeX macros used by KaTeX
- `prose-accepted-words.txt`: accepted words for prose diagnostics

The Emacs configuration links these shared subdirectories from its historical
asset roots. Snippets and templates that Noema does not use stay in the Emacs
repository rather than being mirrored here.
