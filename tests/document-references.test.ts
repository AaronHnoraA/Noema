import { expect, test } from "@voidzero-dev/vite-plus-test";
import { renderMarkdownHTML } from "../src/render-html.ts";
import { createEditor } from "../src/editor-api.ts";
import { markdownHrefAt } from "../src/cm6/editor-cm6.ts";

test("notes and reference links resolve across document block boundaries", () => {
  const markdown = [
    "Outside[^inside] and [inside link][inner].",
    "",
    "#+begin card Example",
    "Inside[^outside] and [outside link][outer].",
    "Repeated[^outside].",
    "",
    "[^inside]: Defined in the card.",
    "[inner]: https://example.test/inside",
    "#+end card",
    "",
    "```md",
    "[^fenced]: A literal definition.",
    "[literal]: https://example.test/literal",
    "```",
    "",
    "Unknown[^fenced] and [literal][literal].",
    "",
    "[^outside]: Defined in the page.",
    "[outer]: https://example.test/outside",
  ].join("\n");
  const fragment = document.createElement("div");
  fragment.innerHTML = renderMarkdownHTML(markdown);
  const related = Array.from(fragment.querySelectorAll<HTMLAnchorElement>(".noema-footnote-reference a"));
  expect(related.map((ref) => ref.getAttribute("href"))).toEqual(["#fn-inside", "#fn-outside", "#fn-outside"]);
  expect(related.map((ref) => ref.textContent)).toEqual(["1", "2", "2"]);
  expect(new Set(related.map((ref) => ref.parentElement?.id)).size).toBe(3);
  expect(fragment.querySelector("#fn-inside .noema-footnote-backref")?.getAttribute("href")).toBe("#fnref-inside-1");
  expect(fragment.querySelector("#fn-outside .noema-footnote-backref")?.getAttribute("href")).toBe("#fnref-outside-1");
  expect(Array.from(fragment.querySelectorAll<HTMLAnchorElement>('a[href^="https:"]')).map((link) => [link.textContent,link.href]))
    .toEqual([["inside link","https://example.test/inside"],["outside link","https://example.test/outside"]]);
  expect(fragment.textContent).toContain("Unknown[^fenced] and [literal][literal].");
});

test("private and literal definitions stay out of the surrounding document scope", () => {
  const markdown = [
    "Outside[^private] and [unresolved][private].",
    "",
    "#+begin comment",
    "[^private]: An isolated definition.",
    "[private]: https://example.test/private",
    "#+end comment",
    "",
    "#+begin card Later",
    "Still unresolved[^private] and [unresolved][private].",
    "#+end card",
  ].join("\n");
  const fragment = document.createElement("div");
  fragment.innerHTML = renderMarkdownHTML(markdown);
  expect(fragment.querySelector(".noema-footnote-reference")).toBeNull();
  expect(fragment.querySelector('a[href="https://example.test/private"]')).toBeNull();
});

test("isolated footnotes have independent fragment IDs and public definitions follow source order", () => {
  const markdown = [
    "Outside[^a b] and[^a-20b] with [a route][route] and[^K].",
    "",
    "#+begin comment",
    "Annotation[^a b].",
    "",
    "[^a b]: Isolated definition.",
    "#+end comment",
    "",
    "#+begin card Earlier",
    "[route]: https://example.test/earlier",
    "#+end card",
    "",
    "[route]: https://example.test/later",
    "[^a b]: First public definition.",
    "[^a-20b]: Similar source label.",
    "[^K]: Non-ASCII label.",
  ].join("\n");
  const fragment = document.createElement("div");
  fragment.innerHTML = renderMarkdownHTML(markdown);
  const ids = Array.from(fragment.querySelectorAll<HTMLElement>("[id]"), (element) => element.id);
  expect(new Set(ids).size).toBe(ids.length);
  const related = [...fragment.querySelectorAll<HTMLAnchorElement>(".noema-footnote-reference a")];
  const definitions = related.map((reference) => {
    return [...fragment.querySelectorAll<HTMLElement>("[role='doc-footnote']")].find((item) => "#" + item.id === reference.hash)?.textContent;
  });
  expect(definitions).toEqual([
    expect.stringContaining("First public definition"),
    expect.stringContaining("Similar source label"),
    expect.stringContaining("Non-ASCII label"),
    expect.stringContaining("Isolated definition"),
  ]);
  expect(fragment.querySelector('a[href="https://example.test/earlier"]')?.textContent).toBe("a route");
});

test("the editor jumps from a rendered card and updates its reference after a definition edit", () => {
  const source = [
    "Outside [the card][ INNER  LINK ] and its note[^inside].",
    "",
    "#+begin card Example",
    "Literal `[^outside]`.",
    "@@hidden [Hidden marker [^outside]]",
    "",
    "Inside[^outside] and [a link][outer].",
    "Again[^outside].",
    "",
    "[^inside]: A card note.",
    "[inner link]: https://example.test/inside",
    "#+end card",
    "",
    "[^outside]: The definition.",
    "[outer]: https://example.test/first",
    "",
    "Tail text.",
  ].join("\n");
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { initialContent: source });
  try {
    editor.setMarkdownSelection(source.length);
    expect(host.querySelector(".cm-footnote-reference button")?.textContent).toBe("1");
    expect(markdownHrefAt(editor.view.state, source.indexOf("the card"))).toBe("https://example.test/inside");
    expect(host.querySelector(".cm-line .syntax-hidden:last-child")?.closest(".cm-content")).not.toBeNull();
    const card = host.querySelector(".noema-document-frame")!;
    const related = Array.from(card.querySelectorAll<HTMLAnchorElement>(".noema-footnote-reference a"));
    expect(related).toHaveLength(2);
    related[1]!.click();
    expect(editor.getMarkdownSelection().from).toBe(source.indexOf("[^outside]:"));
    const definition = source.indexOf("The definition.");
    editor.view.dispatch({ changes: { from: definition, to: definition + 3, insert: "New" } });
    editor.setMarkdownSelection(source.length);
    host.querySelector<HTMLButtonElement>(".cm-footnote-return")!.click();
    expect(editor.getMarkdownSelection().from).toBe(source.indexOf("[^outside]", source.indexOf("Again")));
    editor.setMarkdownSelection(source.length);
    const first = source.indexOf("/first");
    editor.view.dispatch({ changes: {from:first, to:first + 6, insert:"/second"} });
    expect(host.querySelector(".noema-document-frame a[href$='/second']")?.textContent).toBe("a link");
    const updated = host.querySelector(".noema-document-frame");
    const tail = source.indexOf("Tail");
    editor.view.dispatch({ changes: {from:tail + 1, to:tail + 2, insert:"t"} });
    expect(host.querySelector(".noema-document-frame")).toBe(updated);
  } finally {
    editor.destroy();
    host.remove();
  }
});

test("removing a remote list opener invalidates a reference that becomes literal code", () => {
  const source = [
    "Read [source][link].",
    "",
    "10. First part.",
    "    Continued.",
    "    Continued.",
    "    Continued.",
    "",
    "    [link]: https://example.test/list",
  ].join("\n");
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { initialContent: source });
  try {
    const control = source.indexOf("source");
    expect(markdownHrefAt(editor.view.state, control)).toBe("https://example.test/list");
    const opener = source.indexOf("10. ");
    editor.view.dispatch({ changes: { from: opener, to: opener + 4 } });
    expect(markdownHrefAt(editor.view.state, control)).toBeNull();
  } finally {
    editor.destroy();
    host.remove();
  }
});
