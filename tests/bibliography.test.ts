import { afterEach, describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// @ts-ignore The server module is Node ESM outside the TS app graph.
import { bibliographyCompletions, bibliographyForDocument, configureBibliography, parseBibTeX } from "../server/lib/bibliography.mjs";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("bibliography", () => {
  test("parses braced BibTeX values with apostrophes", () => {
    const parsed = parseBibTeX([
      "@string{crelle = {Journal für die reine und angewandte Mathematik (Crelle's Journal)}}",
      "@article{Str87,",
      "  author = {Strassen, Volker},",
      "  title = {Relative Bilinear Complexity and Matrix Multiplication},",
      "  journal = crelle,",
      "  year = {1987},",
      "  pages = {406-443},",
      "  doi = {10.1515/crll.1987.375-376.406}",
      "}",
    ].join("\n"));

    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.entries[0]?.key).toBe("Str87");
    expect(parsed.entries[0]?.fields.journal).toContain("Crelle's Journal");
  });

  test("does not treat TeX accent quotes as unterminated BibTeX strings", () => {
    const parsed = parseBibTeX(String.raw`@book{Godel31,
      author = {G{\"o}del, Kurt},
      title = {On Formally Undecidable Propositions},
      year = {1931}
    }`);

    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]?.key).toBe("Godel31");
    expect(parsed.entries[0]?.fields.author).toContain("Gödel");
  });

  test("resolves forward @string references, # concatenation, and month macros", () => {
    const parsed = parseBibTeX([
      "% @book{Ignored, title={comment}}",
      "@article{Forward,",
      "  journal = journalName # \" — Series A\",",
      "  month = jan,",
      "  year = 2026",
      "}",
      "@string{journalName = baseName # \" Transactions\"}",
      "@string{baseName = \"Noema\"}",
    ].join("\n"));

    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]?.fields).toMatchObject({
      journal: "Noema Transactions — Series A",
      month: "January",
      year: "2026",
    });
  });

  test("diagnoses unknown, cyclic, duplicate, and malformed BibTeX values", () => {
    const parsed = parseBibTeX([
      "@string{loopA = loopB}",
      "@string{loopB = loopA}",
      "@string{dup = \"first\"}",
      "@string{dup = \"second\"}",
      "@book{Broken, title = missingMacro, bad field}",
    ].join("\n"));

    expect(parsed.diagnostics).toContain("Duplicate BibTeX string macro: dup");
    expect(parsed.diagnostics.some((item: string) => item.startsWith("Cyclic BibTeX string macro:"))).toBe(true);
    expect(parsed.diagnostics).toContain("Unknown BibTeX string macro: missingMacro");
    expect(parsed.diagnostics.some((item: string) => item.includes("Broken: invalid field syntax"))).toBe(true);
  });

  test("indexes the note-local bib directory by default and resolves citations", async () => {
    const root = await mkdtemp(join(tmpdir(), "aaronnote-bib-"));
    roots.push(root);
    const noteDir = join(root, "project", "iso");
    await mkdir(join(noteDir, "bib"), { recursive: true });
    await writeFile(join(noteDir, "bib", "iso.bib"), [
      "@article{Str87,",
      "  author = {Strassen, Volker},",
      "  title = {Relative Bilinear Complexity and Matrix Multiplication},",
      "  journal = {Journal für die reine und angewandte Mathematik (Crelle's Journal)},",
      "  year = {1987},",
      "  pages = {406-443},",
      "  doi = {10.1515/crll.1987.375-376.406}",
      "}",
    ].join("\n"), "utf8");
    const file = join(noteDir, "GraphTensor.md");
    const content = [
      "#+begin meta",
      "title: Graph Tensor",
      "#+end meta",
      "",
      "As in @@cite(iso) [Str87] {locator: p. 406}.",
    ].join("\n");
    await writeFile(file, content, "utf8");

    configureBibliography({ root });
    const result = await bibliographyForDocument({ file, content });
    expect(result.diagnostics).toEqual([]);
    expect(result.citations?.[0]?.diagnostics).toEqual([]);
    expect(result.references).toHaveLength(1);
    expect(result.references?.[0]?.text).toContain("Volker Strassen");
    expect(result.references?.[0]?.entry?.file).toBe(await realpath(join(noteDir, "bib", "iso.bib")));
    expect(result.references?.[0]?.entry?.path).toBe("project/iso/bib/iso.bib");

    const namespaces = await bibliographyCompletions({ file, content, kind: "namespaces", prefix: "is" });
    expect(namespaces.items?.find((item: { key?: string }) => item.key === "iso")).toMatchObject({
      body: "iso",
      detail: "project/iso/bib/iso.bib",
    });

    const keys = await bibliographyCompletions({ file, content, kind: "keys", namespace: "iso" });
    expect(keys.items?.find((item: { key?: string }) => item.key === "Str87")).toMatchObject({
      body: "Str87",
      source: "project/iso/bib/iso.bib",
    });
  });

  test("adds declared bibliography paths to the default note-local directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "aaronnote-bib-additive-"));
    roots.push(root);
    const noteDir = join(root, "project");
    await mkdir(join(noteDir, "bib"), { recursive: true });
    await mkdir(join(noteDir, "extra"), { recursive: true });
    await writeFile(join(noteDir, "bib", "local.bib"),
      "@book{Local, author={Author, L}, title={Local Reference}, year={2026}}", "utf8");
    await writeFile(join(noteDir, "extra", "shared.bib"),
      "@book{Shared, author={Author, S}, title={Shared Reference}, year={2025}}", "utf8");
    const file = join(noteDir, "note.md");
    const content = [
      "#+begin meta", "bib: ./extra", "#+end meta", "",
      "See @@cite(local) [Local] and @@cite(shared) [Shared].",
    ].join("\n");
    configureBibliography({ root });

    const namespaces = await bibliographyCompletions({ file, content, kind: "namespaces" });
    expect(namespaces.diagnostics).toEqual([]);
    expect(namespaces.items?.map((item: { key?: string }) => item.key)).toEqual(expect.arrayContaining(["local", "shared"]));

    const result = await bibliographyForDocument({ file, content });
    expect(result.diagnostics).toEqual([]);
    expect(result.references).toHaveLength(2);
  });

  test("resolves citations in a meta summary while keeping metadata fields private", async () => {
    const root = await mkdtemp(join(tmpdir(), "aaronnote-bib-abstract-"));
    roots.push(root);
    await mkdir(join(root, "bib"), { recursive: true });
    await writeFile(join(root, "bib", "refs.bib"),
      "@book{AbstractKey, author={Author, A}, title={Abstract Reference}, year={2026}}", "utf8");
    const file = join(root, "note.md");
    const content = [
      "#+begin meta",
      "title: Literal @@cite(refs) [Hidden]",
      "#+begin summary",
      "Abstract prose @@cite(refs) [AbstractKey].",
      "#+end summary",
      "#+end meta",
    ].join("\n");
    configureBibliography({ root });

    const result = await bibliographyForDocument({ file, content });

    expect(result.diagnostics).toEqual([]);
    expect(result.citations).toHaveLength(1);
    expect(result.citations?.[0]?.keys).toEqual(["AbstractKey"]);
    expect(result.references).toHaveLength(1);
  });

  test("resolves a real note path when the configured Noema root is a symlink", async () => {
    const container = await mkdtemp(join(tmpdir(), "aaronnote-bib-symlink-"));
    roots.push(container);
    const realRoot = join(container, "Noema");
    const linkedRoot = join(container, ".roam");
    const noteDir = join(realRoot, "project", "iso");
    await mkdir(join(noteDir, "bib"), { recursive: true });
    await symlink(realRoot, linkedRoot, "dir");
    await writeFile(join(noteDir, "bib", "iso.bib"), "@article{Str87, author={Strassen, Volker}, title={Relative Bilinear Complexity}, year={1987}}", "utf8");
    const file = join(noteDir, "GraphTensor.md");
    const content = [
      "#+begin meta",
      "title: Symlinked note",
      "#+end meta",
      "",
      "As in @@cite(iso) [Str87].",
    ].join("\n");
    await writeFile(file, content, "utf8");

    configureBibliography({ root: linkedRoot });
    const result = await bibliographyForDocument({ file, content });

    expect(result.diagnostics).toEqual([]);
    expect(result.citations?.[0]?.diagnostics).toEqual([]);
    expect(result.references).toHaveLength(1);
    expect(result.references?.[0]?.entry?.path).toBe("project/iso/bib/iso.bib");
  });

  test("accepts a concrete .bib file in meta instead of requiring a directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "aaronnote-bib-file-"));
    roots.push(root);
    const noteDir = join(root, "project");
    await mkdir(noteDir, { recursive: true });
    await writeFile(join(noteDir, "references.bib"),
      "@book{Str87, author={Strassen, Volker}, title={Algebra}, year={1987}}", "utf8");
    const file = join(noteDir, "note.md");
    const content = [
      "#+begin meta",
      "bib: ./references.bib",
      "#+end meta",
      "",
      "See @@cite(references) [Str87].",
    ].join("\n");
    configureBibliography({ root });

    const result = await bibliographyForDocument({ file, content });

    expect(result.diagnostics).toEqual([]);
    expect(result.citations?.[0]?.diagnostics).toEqual([]);
    expect(result.references).toHaveLength(1);
    expect(result.references?.[0]?.entry?.path).toBe("project/references.bib");
  });

  test("accepts YAML bibliography metadata and quoted paths containing commas", async () => {
    const root = await mkdtemp(join(tmpdir(), "aaronnote-bib-yaml-"));
    roots.push(root);
    const bib = join(root, "refs,2026.bib");
    await writeFile(bib, "@book{YAML, author={Parser, Y}, title={YAML Reference}, year={2026}}", "utf8");
    const file = join(root, "note.md");
    const content = [
      "---", 'bib: "./refs,2026.bib"', "title: YAML note", "---", "",
      "See @@cite(refs,2026) [YAML].",
    ].join("\n");
    await writeFile(file, content, "utf8");
    configureBibliography({ root });

    const result = await bibliographyForDocument({ file, content });

    expect(result.diagnostics).toEqual([]);
    expect(result.citations?.[0]?.diagnostics).toEqual([]);
    expect(result.references?.[0]?.entry?.path).toBe("refs,2026.bib");
  });

  test("resolves a bibliography beside an explicitly opened standalone note", async () => {
    const library = await mkdtemp(join(tmpdir(), "aaronnote-bib-library-"));
    const standalone = await mkdtemp(join(tmpdir(), "aaronnote-bib-standalone-"));
    roots.push(library, standalone);
    await mkdir(join(standalone, "bib"), { recursive: true });
    await writeFile(join(standalone, "bib", "local.bib"),
      "@book{Local, author={Author, L}, title={Standalone Reference}, year={2026}}", "utf8");
    const file = join(standalone, "note.md");
    const content = [
      "#+begin meta", "title: Standalone note", "#+end meta", "",
      "See @@cite(local) [Local].",
    ].join("\n");
    await writeFile(file, content, "utf8");
    configureBibliography({ root: library });

    const result = await bibliographyForDocument({ file, content });

    expect(result.diagnostics).toEqual([]);
    expect(result.citations?.[0]?.diagnostics).toEqual([]);
    expect(result.references).toHaveLength(1);
    expect(result.references?.[0]?.entry?.path).toBe("bib/local.bib");
  });

  test("resolves scoped citations from separate metadata with inherited path provenance", async () => {
    const root = await mkdtemp(join(tmpdir(), "aaronnote-bib-meta-context-"));
    roots.push(root);
    const project = join(root, "project");
    const child = join(project, "chapters");
    await mkdir(join(project, "bib"), { recursive: true });
    await mkdir(child, { recursive: true });
    await writeFile(join(project, "base.md"), [
      "#+begin meta",
      "bib: ./bib",
      "#+end meta",
    ].join("\n"), "utf8");
    await writeFile(join(project, "bib", "refs.bib"),
      "@book{Ada, author={Lovelace, Ada}, title={Notes}, year={1843}}", "utf8");
    const file = join(child, "note.md");
    const metadataContent = [
      "#+begin meta",
      "extend: ../base.md",
      "#+end meta",
      "",
      "# Full document",
    ].join("\n");
    const content = "Scoped text @@CITE(refs)[Ada].";
    await writeFile(file, metadataContent, "utf8");
    configureBibliography({ root });

    const result = await bibliographyForDocument({ file, content, metadataContent });

    expect(result.diagnostics).toEqual([]);
    expect(result.citations?.[0]?.diagnostics).toEqual([]);
    expect(result.citations?.[0]?.items?.[0]).toMatchObject({ key: "Ada", number: 1 });
    expect(result.entries).toHaveLength(1);
    expect(result.entries?.[0]?.path).toBe("project/bib/refs.bib");
  });

  test("ignores literal and private citation contexts when numbering references", async () => {
    const root = await mkdtemp(join(tmpdir(), "aaronnote-bib-contexts-"));
    roots.push(root);
    await writeFile(join(root, "refs.bib"), [
      "@book{Literal, author={Hidden, H}, title={Hidden}, year={2000}}",
      "@book{Label, author={Linked, L}, title={Visible Link Label}, year={2001}}",
      "@book{Real, author={Visible, V}, title={Visible}, year={2001}}",
    ].join("\n"), "utf8");
    const file = join(root, "note.md");
    const content = [
      "#+begin meta", "bib: ./refs.bib", "#+end meta", "",
      "\\@@cite(refs) [Literal]",
      "`@@cite(refs) [Literal]`",
      "\\(@@cite(refs) [Literal]\\)",
      "<!-- @@cite(refs) [Literal] -->",
      "[link](@@cite(refs) [Literal])",
      "[@@cite(refs) [Label]](https://example.test/source)",
      "```text", "@@cite(refs) [Literal]", "```",
      "#+begin lean4", "@@cite(refs) [Literal]", "#+end lean4",
      "Visible @@cite(refs) [Real].",
    ].join("\n");
    await writeFile(file, content, "utf8");
    configureBibliography({ root });

    const result = await bibliographyForDocument({ file, content });

    expect(result.citations).toHaveLength(2);
    expect(result.citations?.map((citation: { keys?: string[] }) => citation.keys)).toEqual([["Label"], ["Real"]]);
    expect(result.references).toHaveLength(2);
    expect(result.references?.map((reference: { entry?: { key?: string } }) => reference.entry?.key)).toEqual(["Label", "Real"]);
  });

  test("returns per-item resolution, de-duplicates repeated keys, and diagnoses empty keys", async () => {
    const root = await mkdtemp(join(tmpdir(), "aaronnote-bib-items-"));
    roots.push(root);
    await writeFile(join(root, "refs.bib"),
      "@book{A, author={Author, A}, title={Alpha}, year={2000}}", "utf8");
    const file = join(root, "note.md");
    const content = [
      "#+begin meta", "bib: ./refs.bib", "#+end meta", "",
      "@@cite(refs) [A; A; ; Missing]",
    ].join("\n");
    await writeFile(file, content, "utf8");
    configureBibliography({ root });

    const result = await bibliographyForDocument({ file, content });
    const citation = result.citations?.[0];

    expect(citation?.keys).toEqual(["A", "Missing"]);
    expect(citation?.itemIds).toHaveLength(1);
    expect(citation?.numbers).toEqual([1]);
    expect(citation?.items).toHaveLength(4);
    expect(citation?.items?.[1]?.duplicate).toBe(true);
    expect(citation?.diagnostics).toContain("citation key is required");
    expect(citation?.diagnostics).toContain("unknown BibTeX key: Missing");
    expect(result.entries).toHaveLength(1);
  });

  test("diagnoses malformed visible citation syntax but ignores literal occurrences", async () => {
    const root = await mkdtemp(join(tmpdir(), "aaronnote-bib-malformed-cite-"));
    roots.push(root);
    configureBibliography({ root });
    const content = [
      "\\@@cite(refs)[Escaped",
      "`@@cite(refs)[Code`",
      "<!-- @@cite(refs)[Comment -->",
      "Visible @@cite(refs)[MissingClose",
      "Also @@cite refs [BadShape]",
    ].join("\n");

    const result = await bibliographyForDocument({ file: join(root, "note.md"), content });

    expect(result.citations).toEqual([]);
    expect(result.diagnostics).toHaveLength(2);
    expect(result.diagnostics?.[0]).toMatch(/unclosed citation key list.*line 4/i);
    expect(result.diagnostics?.[1]).toMatch(/malformed citation command.*line 5/i);
  });

  test("surfaces inherited metadata and BibTeX parse diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "aaronnote-bib-diagnostics-"));
    roots.push(root);
    await writeFile(join(root, "broken.bib"), "@book{Broken, title={never closed}", "utf8");
    const file = join(root, "note.md");
    const content = [
      "#+begin meta", "extend: ./missing-parent.md", "bib: ./broken.bib", "#+end meta", "",
      "@@cite(broken) [Broken]",
    ].join("\n");
    await writeFile(file, content, "utf8");
    configureBibliography({ root });

    const result = await bibliographyForDocument({ file, content });

    expect(result.diagnostics).toContain("extend source not found: ./missing-parent.md");
    expect(result.diagnostics?.some((diagnostic: string) => /broken\.bib: Unclosed BibTeX entry/.test(diagnostic))).toBe(true);
  });

  test("offers only full namespaces when short namespaces are ambiguous", async () => {
    const root = await mkdtemp(join(tmpdir(), "aaronnote-bib-namespace-"));
    roots.push(root);
    await mkdir(join(root, "one"), { recursive: true });
    await mkdir(join(root, "two"), { recursive: true });
    await writeFile(join(root, "one", "refs.bib"), "@book{A, title={A}}", "utf8");
    await writeFile(join(root, "two", "refs.bib"), "@book{B, title={B}}", "utf8");
    const file = join(root, "note.md");
    const content = [
      "#+begin meta", "bib: ./one, ./two", "#+end meta", "",
      "@@cite(one/refs) [A]",
    ].join("\n");
    configureBibliography({ root });

    const namespaces = await bibliographyCompletions({ file, content, kind: "namespaces" });
    const keys = namespaces.items?.map((item: { key?: string }) => item.key);

    expect(keys).toContain("one/refs");
    expect(keys).toContain("two/refs");
    expect(keys).not.toContain("refs");
    const ambiguousKeys = await bibliographyCompletions({ file, content, kind: "keys", namespace: "refs" });
    expect(ambiguousKeys.items).toEqual([]);
    expect(ambiguousKeys.diagnostics).toContain("ambiguous bibliography namespace: refs");
  });
});
