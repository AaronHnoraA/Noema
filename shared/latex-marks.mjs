export const LATEX_MARKS = Object.freeze({
  newline: { placement: "between", latex: "\\\\", symbol: "↵", label: "Line break" },
  nbsp: { placement: "between", latex: "~", symbol: "⍽", label: "Non-breaking space" },
  allowbreak: { placement: "between", latex: "\\allowbreak{}", symbol: "↯", label: "Allow line wrap" },
  noindent: { placement: "prefix", latex: "\\noindent", symbol: "¶←", label: "No paragraph indent" },
  newpage: { placement: "block", latex: "\\newpage", symbol: "↧", label: "New page" },
  clearpage: { placement: "block", latex: "\\clearpage", symbol: "⇊", label: "Flush floats and start page" },
  nopagebreak: { placement: "block", latex: "\\nopagebreak[4]", symbol: "↥", label: "Prevent page break" },
  keepnext: { placement: "block", latex: "\\Needspace{4\\baselineskip}", symbol: "⤓", label: "Keep next block together" },
  appendix: { placement: "block-once", latex: "\\appendix", symbol: "§A", label: "Start appendices" },
});

export function latexMark(name) {
  return LATEX_MARKS[String(name || "").trim().toLowerCase()] || null;
}

export function latexMarkNames() {
  return Object.keys(LATEX_MARKS);
}

/**
 * `@@latexmk(prompt) [instruction]`: an instruction to the typesetting Agent
 * for the markup at this spot ("set this table landscape", "keep these two
 * figures on one page"). It is not a LaTeX command: the Pandoc pass leaves
 * `\noemaprompt{instruction}` in the draft, which expands to nothing, and the
 * polish Agent carries it out and removes it.
 */
export const LATEX_PROMPT_MARK = "prompt";

/** Names offered after `@@latexmk(`: the marks, then the Agent instruction. */
export function latexMarkChoiceNames() {
  return [...Object.keys(LATEX_MARKS), LATEX_PROMPT_MARK];
}

export function latexMarkSnippetDefinitions() {
  return [
    ...Object.entries(LATEX_MARKS).map(([key, spec]) => ({ key, name: `LaTeX mark: ${spec.label}`, body: `@@latexmk(${key})$0` })),
    { key: LATEX_PROMPT_MARK, name: "LaTeX mark: instruction for the typesetting Agent", body: "@@latexmk(prompt) [${1:instruction}]$0" },
  ];
}
