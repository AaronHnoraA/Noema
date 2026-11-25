import { expect, test } from "@voidzero-dev/vite-plus-test";
import { createEditor } from "../src/editor-api.ts";
import { renderMarkdownHTML } from "../src/render-html.ts";

const tabs = [
  "#+begin tabs Read {selected=2}",
  "### Overview", "A first page.",
  "#### A smaller heading", "Stays in the first page.",
  "### Details", "A second page with a [link][notes].",
  "", "[notes]: #other", "#+end tabs",
].join("\n");

const code = "#+begin code-tabs Examples\n```bash\nnoema render\n```\n\n```python\nprint(42)\n```\n#+end code-tabs";

test("static rendering keeps every page, its levels, and shared references", () => {
  const host = document.createElement("div");
  host.innerHTML = renderMarkdownHTML(tabs);
  const group = host.querySelector(".noema-document-tabs-static");
  expect(group?.querySelectorAll("h3")).toHaveLength(2);
  expect(group?.querySelector("h4")?.textContent).toBe("A smaller heading");
  expect(group?.querySelector("a")?.getAttribute("href")).toBe("#other");
  expect(group?.querySelector("button, template")).toBeNull();
});

test("parent actions mount one connected page and preserve the choice across an outside edit", async () => {
  const source = `${tabs}\n\n${tabs}\n\nAfter.`;
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent: source });
  function group(index: number) {
    return host.querySelectorAll<HTMLElement>(".noema-document-tabs")[index]!;
  }
  function active(index: number) {
    return group(index).querySelector("[role=tab][aria-selected=true]");
  }
  try {
    editor.setMarkdownSelection(source.length);
    await Promise.resolve();
    expect(active(0)?.textContent).toBe("Details");
    expect(group(0).querySelector("[role=tabpanel]:not([hidden])")?.textContent).toContain("A second page");
    expect(group(0).querySelector("[role=tabpanel]:not([hidden])")?.textContent).not.toContain("A first page");
    const tab = active(0)!;
    tab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    expect(active(0)?.textContent).toBe("Overview");
    expect(active(1)?.textContent).toBe("Details");
    expect(group(0).querySelector("[role=tabpanel]:not([hidden])")?.textContent).toContain("A smaller heading");
    editor.view.dispatch({ changes: { from: 0, insert: "Before.\n\n" } });
    await Promise.resolve();
    expect(active(0)?.textContent).toBe("Overview");
    expect(active(1)?.textContent).toBe("Details");
    editor.setMarkdownSelection(editor.getMarkdown().indexOf("A first page"));
    expect(host.querySelectorAll(".noema-document-tabs")).toHaveLength(1);
    editor.setMarkdownSelection(editor.getMarkdown().length);
    await Promise.resolve();
    expect(active(0)?.textContent).toBe("Overview");
    editor.toggleSource();
    editor.view.dispatch({ changes: { from: 0, insert: "Source edit.\n\n" } });
    editor.toggleSource();
    await Promise.resolve();
    expect(active(0)?.textContent).toBe("Overview");
    expect(editor.getMarkdown()).toBe(`Source edit.\n\nBefore.\n\n${source}`);
  } finally {
    editor.destroy();
    host.remove();
  }
});

test("code groups infer fence labels and show only the selected code", async () => {
  const source = `${code}\n\nAfter.`;
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent: source });
  try {
    editor.setMarkdownSelection(source.length);
    await Promise.resolve();
    const tabs = [...host.querySelectorAll<HTMLButtonElement>("[role=tab]")];
    expect(tabs.map((tab) => tab.textContent)).toEqual(["bash", "python"]);
    expect(host.querySelector("[role=tabpanel] code")?.textContent).toContain("noema render");
    tabs[1]!.click();
    expect(host.querySelector("[role=tabpanel] code")?.textContent).toContain("print(42)");
    expect(editor.getMarkdown()).toBe(source);
  } finally {
    editor.destroy();
    host.remove();
  }
});

test("a swiper exposes its bounded navigation and owns a unique ARIA panel for each page", async () => {
  const source = `${tabs.replaceAll("tabs", "swiper").replace("selected=2", "selected=1")}\n\nAfter.`;
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent: source });
  try {
    editor.setMarkdownSelection(source.length);
    await Promise.resolve();
    const previous = host.querySelector<HTMLButtonElement>("[aria-label='Previous page']")!;
    const next = host.querySelector<HTMLButtonElement>("[aria-label='Next page']")!;
    expect(previous.disabled).toBe(true);
    expect(next.disabled).toBe(false);
    next.click();
    expect(previous.disabled).toBe(false);
    expect(next.disabled).toBe(true);
    const panel = host.querySelector("[role=tabpanel]:not([hidden])");
    const detail = host.querySelector("[role=tab][aria-selected=true]");
    expect(detail?.getAttribute("aria-controls")).toBe(panel?.id);
    expect(panel?.getAttribute("aria-labelledby")).toBe(detail?.id);
    let href = "";
    host.addEventListener("noema:open-url", (event) => {
      event.preventDefault();
      href = (event as CustomEvent<{ href: string }>).detail.href;
    });
    panel?.querySelector("a")?.click();
    expect(href).toBe("#other");
  } finally {
    editor.destroy();
    host.remove();
  }
});

test("clicking an active page reveals its real source after an earlier layout line", async () => {
  const source = "#+begin tabs Guide {selected=2}\n### Table\n| Title |\n|---|\n| Value |\n{width=60%}\n\n### Details\nThe selected paragraph.\n#+end tabs\n\nAfter.";
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent: source });
  try {
    editor.setMarkdownSelection(source.length);
    await Promise.resolve();
    host.querySelector("[role=tabpanel]:not([hidden]) p")?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(editor.view.state.selection.main.anchor).toBe(source.indexOf("The selected paragraph."));
    expect(editor.getMarkdown()).toBe(source);
  } finally {
    editor.destroy();
    host.remove();
  }
});

test("tabs inside folds and columns keep their choice across a containing widget rebuild", async () => {
  const pages = tabs.replace("selected=2", "selected=1").replace("A second page with a [link][notes].", "- [x] Ready");
  for (const container of ["fold", "columns"]) {
    const tail = container === "columns" ? "\n#+col\nOther pane.\n" : "\n";
    const source = `#+begin ${container}\nIntro.\n\n${pages}${tail}#+end ${container}\n\nAfter.`;
    const host = document.createElement("div");
    document.body.append(host);
    const editor = createEditor(host, { kernel: "cm6", initialContent: source });
    try {
      editor.setMarkdownSelection(source.length);
      await Promise.resolve();
      host.querySelector<HTMLButtonElement>(".org-env-fold-summary")?.click();
      const second = host.querySelector<HTMLButtonElement>("button[data-tab-index='1']")!;
      second.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      expect(second.isConnected).toBe(true);
      second.click();
      expect(host.querySelector(".noema-tab-pane .checkbox[data-checked='1']")).not.toBeNull();
      editor.view.dispatch({ changes: { from: source.indexOf("Intro."), to: source.indexOf("Intro.") + 6, insert: "Revised introduction." } });
      await Promise.resolve();
      host.querySelector<HTMLButtonElement>(".org-env-fold-summary[aria-expanded='false']")?.click();
      expect(host.querySelector("[role=tab][aria-selected=true]")?.textContent).toBe("Details");
      editor.setMarkdownSelection(editor.getMarkdown().indexOf("Revised introduction."));
      await Promise.resolve();
      expect(host.querySelector("[role=tab][aria-selected=true]")?.textContent).toBe("Details");
    } finally {
      editor.destroy();
      host.remove();
    }
  }
});
