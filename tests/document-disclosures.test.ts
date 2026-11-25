import { expect, test } from "@voidzero-dev/vite-plus-test";
import { createEditor } from "../src/editor-api.ts";
import { renderMarkdownHTML, renderPublishedNoteHTML } from "../src/render-html.ts";

const details = "#+begin details Project notes {open=true} {#details-example}\nA **complete** explanation.\n#+end details";
const accordion = [
  "#+begin accordion Reading {open=2}",
  "### Scope", "Only the current note.",
  "### Method", "- [x] Check the work.", "",
  "### Limits", "The source remains readable.",
  "#+end accordion",
].join("\n");

test("published disclosures keep all Markdown and the authored defaults", () => {
  const host = document.createElement("div");
  host.innerHTML = renderMarkdownHTML(`${details}\n\n${accordion}\n\n${accordion}`);
  const standalone = host.querySelector<HTMLDetailsElement>("details[data-kind=details]");
  expect(standalone?.open).toBe(true);
  expect(standalone?.querySelector("summary")?.textContent).toBe("Project notes");
  expect(standalone?.querySelector("strong")?.textContent).toBe("complete");
  expect(standalone?.dataset.blockId).toBe("details-example");
  const groups = [...host.querySelectorAll(".noema-document-accordion")];
  expect(groups).toHaveLength(2);
  expect(groups[0]?.querySelector("details[open] summary")?.textContent).toBe("Method");
  expect(groups[0]?.textContent).toContain("The source remains readable.");
  const names = groups.map((group) => group.querySelector("details")?.getAttribute("name"));
  expect(names.every(Boolean)).toBe(true);
  expect(new Set(names).size).toBe(2);
});

test("print opens all disclosures and retains labels with inline code", () => {
  const host = document.createElement("div");
  host.innerHTML = renderPublishedNoteHTML(`${details.replace("Project notes", "Project \`Noema\` notes")}\n\n${accordion}`, { title: "Guide", format: "pdf" });
  expect(host.querySelectorAll("details.noema-document-disclosure[open]")).toHaveLength(4);
  expect(host.querySelector("details[data-kind=details] summary")?.textContent).toBe("Project Noema notes");
  expect(host.querySelector(".noema-document-accordion details[name]")).toBeNull();
});

test("details opens with its authored state and stays closed across a source edit", async () => {
  const source = `${details}\n\nAfter.`;
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent: source });
  try {
    editor.setMarkdownSelection(source.length);
    await Promise.resolve();
    const rendered = () => host.querySelector<HTMLDetailsElement>("details[data-kind=details]");
    expect(rendered()?.open).toBe(true);
    rendered()?.querySelector("summary")?.click();
    expect(rendered()?.open).toBe(false);
    expect(rendered()?.querySelector("strong")).toBeNull();
    editor.toggleSource();
    editor.view.dispatch({ changes: { from: 0, insert: "Before.\n\n" } });
    editor.toggleSource();
    await Promise.resolve();
    expect(rendered()?.open).toBe(false);
    expect(editor.getMarkdown()).toBe(`Before.\n\n${source}`);
    host.querySelector<HTMLButtonElement>(".noema-disclosure-edit")?.click();
    expect(rendered()).toBeNull();
    expect(editor.view.state.selection.main.anchor).toBe("Before.\n\n".length);
  } finally {
    editor.destroy();
    host.remove();
  }
});

test("single and multiple accordion choices use ordinary section headings", async () => {
  const variant = accordion.replace("open=2", 'multiple=true open="1,3"');
  const source = `${accordion}\n\n${variant}\n\nAfter.`;
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent: source });
  try {
    editor.setMarkdownSelection(source.length);
    await Promise.resolve();
    const groups = [...host.querySelectorAll(".noema-document-accordion")];
    const open = (index: number) => [...groups[index]!.querySelectorAll("details[open] summary")].map((item) => item.textContent);
    expect(open(0)).toEqual(["Method"]);
    expect(groups[0]?.querySelector("details[open] .checkbox[data-checked='1']")).not.toBeNull();
    expect(open(1)).toEqual(["Scope", "Limits"]);
    const control = groups[0]!.querySelector("summary")!;
    control.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(control.isConnected).toBe(true);
    control.click();
    expect(open(0)).toEqual(["Scope"]);
    [...groups[1]!.querySelectorAll("summary")][1]!.click();
    expect(open(1)).toEqual(["Scope", "Method", "Limits"]);
    expect(editor.getMarkdown()).toBe(source);
  } finally {
    editor.destroy();
    host.remove();
  }
});

test("a click in a disclosure body opens the corresponding Markdown section", async () => {
  const source = `${details}\n\n${accordion.replace("open=2", "open=3")}\n\nAfter.`;
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent: source });
  try {
    editor.setMarkdownSelection(source.length);
    await Promise.resolve();
    const selected = host.querySelector(".noema-document-accordion details[open] .noema-disclosure-body p");
    selected?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(editor.view.state.selection.main.anchor).toBe(source.indexOf("The source remains readable."));
    editor.setMarkdownSelection(source.length);
    await Promise.resolve();
    host.querySelector("details[data-kind=details] .noema-disclosure-body p")?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(editor.view.state.selection.main.anchor).toBe(source.indexOf("A **complete** explanation."));
  } finally {
    editor.destroy();
    host.remove();
  }
});
