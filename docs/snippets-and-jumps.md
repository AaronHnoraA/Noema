# Snippets and Cmd+[ / ] navigation

## Getting suggestions

Noema uses Markdown snippets in prose and TeX snippets only inside
`\(...\)` or `\[...\]`. An unfinished opener is recognized while typing, but
code blocks and HTML blocks are excluded.

Inside math there are three input styles:

- Type a command prefix such as `\fr` to see KaTeX-compatible commands.
- Type an `@` shortcut such as `@a` or `@/` for LaTeX Workshop-style fast input.
- Continue using personal keys such as `frac`, `ali`, or `cas`. Plain keys use
  exact/prefix matching only, so ordinary words do not cause noisy matches.

The popup shows at most ten results. Use Up/Down, Page Up/Page Down, Home/End,
Cmd+1…Cmd+0, or Tab. Enter remains normal editor input. Escape dismisses the
current popup. Snippet choices use the same popup.

Ranking is deterministic: valid context and exactness come first, then local
snippet priority, current-note frequency, Overleaf frequency, and local usage
history. Local history never leaves the browser. Use **Tools → Reset snippet
ranking** to clear it.

## Editing fields

- Tab and Cmd+] move forward; Shift-Tab and Cmd+[ move backward.
- Fields do not wrap at either end.
- Mirrors are synchronized when leaving their source field.
- Nested snippets complete before returning to the parent snippet.
- LiveTeX fields are a nested snippet layer. They complete first, then hand off
  to the next outer source-snippet field. If no such field exists, the formula
  boundary remains a strict no-op.
- Selecting text before inserting a wrapping snippet supplies
  `yas-selected-text`.
- Clicking or moving the selection outside the active field cancels the entire
  snippet session immediately. Old fields are never revisited afterward.
- Escape, changing note, and reload also end the session.

## Structural fallback

When there is no active snippet, Cmd+[ and Cmd+] become bounded structural
jumps. Copilot acceptance still has first priority when its ghost text is
visible.

The fallback searches only the current inline/display math range, Markdown
link, or Markdown block. It respects escapes, ignores inline-code brackets,
does not wrap, and never searches more than 16 KiB. Cmd+] lands after the
nearest matching closer; Cmd+[ lands just inside the matching opener. If no
valid target exists, the cursor does not move.

This strict no-op behavior is intentional: it prevents a stale snippet or a
delimiter search from throwing the cursor into another region of the note.
