import { expect, test } from "@voidzero-dev/vite-plus-test";
import { createEditor } from "../../src/editor-api.ts";

test("adjacent native Markdown images form a layout row and reorder in one undo step", () => {
  const source = "before\n\n![A](a.png) ![B](b.png)\n\nafter";
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent: source });
  editor.setMarkdownSelection(source.length);
  try {
    const images = [...host.querySelectorAll<HTMLElement>(".cm-image-widget")];
    expect(images).toHaveLength(2);
    expect(images.every((image) => image.classList.contains("cm-image-row-item"))).toBe(true);
    expect(images[0]?.querySelector(".cm-image-row-grip")).toBeTruthy();
    expect(editor.getMarkdown()).toBe(source);
    images[0]?.querySelector(".cm-image-row-grip")?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight", altKey: true }));
    expect(editor.getMarkdown()).toBe("before\n\n![B](b.png) ![A](a.png)\n\nafter");
    editor.undo();
    expect(editor.getMarkdown()).toBe(source);
  } finally { editor.destroy(); host.remove(); }
});

test("prose between images does not become a row", () => {
  const source = "![A](a.png) and ![B](b.png)";
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent: source });
  editor.setMarkdownSelection(source.length);
  try { expect(host.querySelector(".cm-image-row-grip")).toBeNull(); }
  finally { editor.destroy(); host.remove(); }
});

test("row splitter writes both native width attrs in one undo step", () => {
  const source = "![A](a.png){align=left data-note=keep} ![B](b.png)\n\nafter";
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent: source });
  editor.setMarkdownSelection(source.length);
  try {
    const handle = host.querySelector<HTMLButtonElement>(".cm-image-row-split");
    expect(handle).toBeTruthy();
    handle!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }));
    const changed = editor.getMarkdown();
    expect(changed).toMatch(/!\[A\]\(a\.png\)\{data-note=keep align=left width=[\d.]+%\}/);
    expect(changed).toMatch(/!\[B\]\(b\.png\)\{width=[\d.]+%\}/);
    editor.undo();
    expect(editor.getMarkdown()).toBe(source);
  } finally { editor.destroy(); host.remove(); }
});

test("row height control applies one height to both images", () => {
  const source = "![A](a.png) ![B](b.png)\n\nafter";
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent: source });
  editor.setMarkdownSelection(source.length);
  try {
    const handle = host.querySelector<HTMLButtonElement>(".cm-image-row-height");
    expect(handle).toBeTruthy();
    handle!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" }));
    expect(editor.getMarkdown()).toBe("![A](a.png){height=236px} ![B](b.png){height=236px}\n\nafter");
    editor.undo();
    expect(editor.getMarkdown()).toBe(source);
  } finally { editor.destroy(); host.remove(); }
});

test("toolbar joins adjacent native image lines without changing embed source", () => {
  const source = "![A](a.png){width=40%}\n\n![B](b.png)\n\nafter";
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent: source });
  editor.setMarkdownSelection(source.length);
  try {
    const join = host.querySelector<HTMLButtonElement>('button[title="Place with next image"]');
    expect(join).toBeTruthy();
    join!.click();
    expect(editor.getMarkdown()).toBe("![A](a.png){width=40%} ![B](b.png)\n\nafter");
    expect(host.querySelectorAll(".cm-image-row-grip")).toHaveLength(2);
    editor.undo();
    expect(editor.getMarkdown()).toBe(source);
  } finally { editor.destroy(); host.remove(); }
});

test("double click opens row image viewer with arrow navigation and Escape", () => {
  const source = "![A](a.png) ![B](b.png)\n\nafter";
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent: source });
  editor.setMarkdownSelection(source.length);
  try {
    host.querySelector<HTMLImageElement>("img.cm-image-render")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    expect(document.querySelector(".cm-image-viewer-counter")?.textContent).toBe("1 / 2");
    document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }));
    expect(document.querySelector(".cm-image-viewer-counter")?.textContent).toBe("2 / 2");
    document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    expect(document.querySelector(".cm-image-viewer")).toBeNull();
    expect(editor.getMarkdown()).toBe(source);
  } finally { document.querySelector<HTMLElement>(".cm-image-viewer-close")?.click(); editor.destroy(); host.remove(); }
});

test("removing an adjacent image removes the stale move grip", () => {
  const source = "![A](a.png) ![B](b.png)\n\nafter";
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent: source });
  editor.setMarkdownSelection(source.length);
  try {
    expect(host.querySelectorAll(".cm-image-row-grip")).toHaveLength(2);
    editor.replaceMarkdownRange(11, source.indexOf("\n"), "");
    expect(host.querySelector(".cm-image-row-grip")).toBeNull();
    expect(editor.getMarkdown()).toBe("![A](a.png)\n\nafter");
  } finally { editor.destroy(); host.remove(); }
});
