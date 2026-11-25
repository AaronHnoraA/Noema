import { expect, test, vi } from "@voidzero-dev/vite-plus-test";
import { createEditor } from "../src/editor-api.ts";
import { renderMarkdownHTML, renderPublishedNoteHTML } from "../src/render-html.ts";
import { setSystemClipboardWriter } from "../src/system-clipboard.ts";
import { sortTableBodyRows } from "../src/cm6/table-model.ts";

const table = [
  "#+begin table Timing {sortable=true copy=true highlight-cells=\"1:2 3:1\"}",
  "| Phase | Latency (ms) |",
  "| --- | ---: |",
  "| [Paint](https://example.com) | 14 |",
  "| **Parse** \\| tokens | -2 |",
  "| Layout | 0 |",
  "#+end table",
].join("\n");

test("table view preserves GFM alignment, markup, and source highlights", () => {
  const root = document.createElement("div");
  root.innerHTML = renderMarkdownHTML(table, { documentTableActions: true });
  expect(root.querySelector("org-env-block")?.getAttribute("data-title")).toBe("Timing");
  const grid = root.querySelector(".noema-document-table-view table");
  expect(grid?.querySelector("thead th:last-child")?.getAttribute("aria-sort")).toBe("none");
  expect(grid?.querySelector("tbody tr:first-child td:last-child")?.getAttribute("data-highlight")).toBe("true");
  expect(grid?.querySelector("tbody tr:first-child a")?.getAttribute("href")).toBe("https://example.com");
  expect(grid?.querySelector("tbody tr:nth-child(2) td:first-child")?.textContent).toBe("Parse | tokens");
});

test("published tables contain formatted data without editor copy metadata", () => {
  const page = renderPublishedNoteHTML(table, { title: "Timing" });
  expect(page).toContain("noema-document-table-view");
  expect(page).toContain("https://example.com");
  expect(page).not.toContain("data-table-source");
  expect(page).not.toContain("data-copy-table");
});

test("sort treats finite exponents as numbers and groups mixed keys consistently", () => {
  const keys = [["1e3"], ["-2"], ["-5 units"], ["2"], ["-10"], ["2"]];
  expect(sortTableBodyRows(keys, 0, 1, (row) => row, 0).map((row) => row[0]))
    .toEqual(["-10", "-2", "2", "2", "1e3", "-5 units"]);
});

test("copy keeps reference definitions needed by the table's links", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const source = `${table.replace("[Paint](https://example.com)", "[Paint][where]")
    .replace("#+end table", "\n[where]: https://example.com \"Reference\"\n#+end table")}\n\nAfter.`;
  const editor = createEditor(host, { kernel: "cm6", initialContent: source });
  const writer = vi.fn(async (_text: string) => true);
  setSystemClipboardWriter(writer);
  try {
    editor.setMarkdownSelection(source.length);
    host.querySelector<HTMLButtonElement>("[data-copy-table]")?.click();
    await vi.waitFor(() => expect(writer).toHaveBeenCalledOnce());
    const output = document.createElement("div");
    output.innerHTML = renderMarkdownHTML(writer.mock.calls[0]![0]);
    expect(output.querySelector("td a")?.getAttribute("href")).toBe("https://example.com");
    expect(output.querySelector("td a")?.getAttribute("title")).toBe("Reference");
  } finally {
    setSystemClipboardWriter(null);
    editor.destroy();
    host.remove();
  }
});

test("visible cell anchors use the original comment text and Markdown-it pipe rules", () => {
  const source = "| Label | Value | Extra |\n|---|---:|---|\n| {==Alpha==}{>>#c-abcd<<} | 75 | |\n"
    + String.raw`| Alpha \\| literal | 77 |`;
  const root = document.createElement("div");
  root.innerHTML = renderMarkdownHTML(`#+begin table\n${source}\n#+end table`, { documentTableActions: true, documentTableSource: `${source}\n` });
  const secondColumn = Array.from(root.querySelectorAll<HTMLTableCellElement>("tbody td:nth-child(2)"), (cell) => cell.dataset.cmSourceOffset);
  expect(secondColumn.map(Number)).toEqual([source.indexOf("75"), source.indexOf("77")]);
  const paddedCell = root.querySelector<HTMLElement>("tbody tr:last-child td:last-child");
  expect(Number(paddedCell?.dataset.cmSourceOffset)).toBe(source.length - 1);
});

test("sort and copy follow the reading order without editing Markdown", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const source = `${table}\n\nAfter.`;
  const editor = createEditor(host, { kernel: "cm6", initialContent: source });
  const writer = vi.fn(async (_text: string) => true);
  setSystemClipboardWriter(writer);
  try {
    editor.setMarkdownSelection(source.length);
    const tableView = host.querySelector(".noema-document-table-view");
    expect(tableView).not.toBeNull();
    const sort = tableView!.querySelector<HTMLButtonElement>("[data-sort-column='1']")!;
    const copy = tableView!.querySelector<HTMLButtonElement>("[data-copy-table]")!;
    const order = () => Array.from(tableView!.querySelectorAll("tbody td:last-child"), (cell) => cell.textContent);
    sort.click();
    expect(order()).toEqual(["-2", "0", "14"]);
    expect(sort.closest("th")?.getAttribute("aria-sort")).toBe("ascending");
    copy.click();
    await vi.waitFor(() => expect(writer).toHaveBeenCalledOnce());
    const copied = writer.mock.calls[0]?.[0] || "";
    expect(copied).toContain("| --- | ---: |");
    expect(copied.indexOf("**Parse** \\| tokens")).toBeLessThan(copied.indexOf("Layout"));
    expect(copied.indexOf("Layout")).toBeLessThan(copied.indexOf("[Paint]"));
    sort.click();
    expect(order()).toEqual(["14", "0", "-2"]);
    expect(editor.getMarkdown()).toBe(source);
  } finally {
    setSystemClipboardWriter(null);
    editor.destroy();
    host.remove();
  }
});

test("expanded folds and rendered columns keep table actions", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const source = `#+begin fold Example\n${table}\n#+end fold\n\n#+begin columns\n${table}\n#+col\nNotes.\n#+end columns\n\nAfter.`;
  const editor = createEditor(host, { kernel: "cm6", initialContent: source });
  try {
    editor.setMarkdownSelection(source.length);
    host.querySelector<HTMLButtonElement>(".org-env-fold-summary")?.click();
    for (const parent of [".org-env-fold-content", ".cm-column-pane-body"]) {
      const sheet = host.querySelector(`${parent} .noema-document-table-view`);
      expect(sheet?.querySelector("[data-copy-table]")).not.toBeNull();
      sheet?.querySelector<HTMLButtonElement>("[data-sort-column='1']")?.click();
      expect(sheet?.querySelector("tbody td:last-child")?.textContent).toBe("-2");
    }
    expect(editor.getMarkdown()).toBe(source);
  } finally {
    editor.destroy();
    host.remove();
  }
});
