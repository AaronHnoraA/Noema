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

export function latexMarkSnippetDefinitions() {
  return Object.entries(LATEX_MARKS).map(([key, spec]) => ({ key, name: `LaTeX mark: ${spec.label}`, body: `@@latexmk(${key})$0` }));
}
