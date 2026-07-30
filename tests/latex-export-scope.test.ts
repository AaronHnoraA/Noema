import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import {
  buildLatexExportScopes,
  latexExportScopeContent,
  latexExportScopesContent,
  latexHeadingRange,
  toggleLatexExportScopeSelection,
} from "../aaronnote/latex-export-scope.ts";

describe("LaTeX export scopes", () => {
  const markdown = [
    "Intro.",
    "",
    "# Alpha",
    "A.",
    "",
    "## Nested",
    "N.",
    "",
    "# Hidden boundary",
    "H.",
    "",
    "# Omega",
    "O.",
    "",
  ].join("\n");
  const marker = (text: string) => markdown.indexOf(text);
  const headings = [
    { level: 1, text: "Alpha", pos: marker("Alpha"), markerFrom: marker("# Alpha") },
    { level: 2, text: "Nested", pos: marker("Nested"), markerFrom: marker("## Nested") },
    { level: 1, text: "Hidden boundary", pos: marker("Hidden boundary"), markerFrom: marker("# Hidden boundary"), omit: true },
    { level: 1, text: "Omega", pos: marker("Omega"), markerFrom: marker("# Omega") },
  ];

  test("uses omitted headings as subtree boundaries without offering them", () => {
    const range = latexHeadingRange(markdown, headings, 0);
    expect(markdown.slice(range.from, range.to)).toContain("## Nested");
    expect(markdown.slice(range.from, range.to)).not.toContain("# Hidden boundary");

    const scopes = buildLatexExportScopes({ markdown, headings, cursor: marker("N.") });
    expect(scopes.map((scope) => scope.title)).toEqual(["Whole note", "Alpha", "Nested", "Omega"]);
    expect(scopes.find((scope) => scope.active)?.title).toBe("Nested");
  });

  test("offers an explicit text-selection scope and extracts exact content", () => {
    const from = marker("A.");
    const to = from + 2;
    const scopes = buildLatexExportScopes({
      markdown,
      headings,
      selection: { from, to },
      cursor: from,
    });
    const selection = scopes.find((scope) => scope.kind === "selection")!;
    expect(selection.title).toBe("Text selection");
    expect(latexExportScopeContent(markdown, selection)).toBe("A.");
  });

  test("supports non-overlapping multi-section selection in document order", () => {
    const scopes = buildLatexExportScopes({ markdown, headings });
    const alpha = scopes.find((scope) => scope.title === "Alpha")!;
    const nested = scopes.find((scope) => scope.title === "Nested")!;
    const omega = scopes.find((scope) => scope.title === "Omega")!;

    let selected = toggleLatexExportScopeSelection(scopes, new Set(), nested.id);
    selected = toggleLatexExportScopeSelection(scopes, selected, omega.id);
    expect([...selected]).toEqual([nested.id, omega.id]);
    expect(latexExportScopesContent(markdown, scopes.filter((scope) => selected.has(scope.id))))
      .toBe("## Nested\nN.\n\n# Omega\nO.\n");

    selected = toggleLatexExportScopeSelection(scopes, selected, alpha.id);
    expect([...selected]).toEqual([omega.id, alpha.id]);
    selected = toggleLatexExportScopeSelection(scopes, selected, "document");
    expect([...selected]).toEqual(["document"]);
  });

  test("preserves trailing code whitespace byte-for-byte for a single scope", () => {
    const source = "# Code\n\n```text\nalpha  \n\n\n```\n";
    const scope = buildLatexExportScopes({
      markdown: source,
      headings: [{ level: 1, text: "Code", pos: 2, markerFrom: 0 }],
    }).find((candidate) => candidate.kind === "heading")!;
    expect(latexExportScopeContent(source, scope)).toBe(source);
    expect(latexExportScopesContent(source, [scope])).toBe(source);
  });
});
