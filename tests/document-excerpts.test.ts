import { expect, test, vi } from "@voidzero-dev/vite-plus-test";
import { createEditor } from "../src/editor-api.ts";
import { renderMarkdownHTML } from "../src/render-html.ts";
import { setSystemClipboardWriter } from "../src/system-clipboard.ts";

const source = '#+begin include Snapshot {src="src/readme.md" section="Read me"}\nVisible fallback.\n#+end include\n\n'
  + '#+begin code-ref Implementation {src="src/example.el" symbol=example context=1}\n#+end code-ref\n\nTail.';

test("publishes authored fallback and a path label rather than requesting local source", () => {
  const root = document.createElement("div");
  root.innerHTML = renderMarkdownHTML(source);
  expect(root.textContent).toContain("Visible fallback.");
  expect(root.querySelector(".noema-excerpt-reference")?.textContent).toBe("src/example.el");
  expect(root.querySelector("[data-excerpt-src], [data-excerpt-copy]")).toBeNull();
});

test("editor loads workspace snippets, copies the exact text, and opens the first source line", async () => {
  const originalApi = window.noemaApi;
  const originalNote = window.NoemaCurrentFile;
  const oldUrl = window.location.href;
  const read = vi.fn(async () => ({ ok: true, file: "/workspace/src/example.el", path: "src/example.el",
    body: "(defun example ()\r\n  (message \"Example\"))", language: "elisp", startLine: 7, endLine: 8, totalLines: 11, truncated: false }));
  const open = vi.fn(async () => ({ ok: true }));
  const clipboard = vi.fn(async () => true);
  vi.stubGlobal("IntersectionObserver", undefined);
  window.noemaApi = { noteCode: { readExcerpt: read }, emacs: { open } };
  window.history.replaceState({}, "", "?file=/previous/note.md");
  window.NoemaCurrentFile = () => "/workspace/note.md";
  setSystemClipboardWriter(clipboard);
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, {initialContent:source});
  try {
    editor.setMarkdownSelection(source.length);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(read).toHaveBeenCalledWith(expect.objectContaining({ notePath:"/workspace/note.md", path:"src/example.el", symbol:"example", context:"1" }));
    const excerpt = host.querySelector<HTMLElement>('[data-excerpt-symbol="example"]')!;
    expect(excerpt.querySelector(".noema-excerpt-lines")?.textContent).toBe("L7–8");
    expect(excerpt.querySelector(".noema-excerpt-code")?.textContent).toContain("(defun example");
    excerpt.querySelector<HTMLButtonElement>("[data-excerpt-copy]")?.click();
    excerpt.querySelector<HTMLButtonElement>("[data-excerpt-open]")?.click();
    expect(clipboard).toHaveBeenCalledWith("(defun example ()\r\n  (message \"Example\"))");
    expect(open).toHaveBeenCalledWith({ file:"/workspace/src/example.el", line:7 });
    read.mockRejectedValueOnce(new Error("The source was renamed."));
    excerpt.querySelector<HTMLButtonElement>("[data-excerpt-refresh]")?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(excerpt.querySelector(".noema-excerpt-code")).toBeNull();
    expect(excerpt.querySelector(".noema-excerpt-status")?.textContent).toBe("The source was renamed.");
    expect(excerpt.querySelector("[data-excerpt-copy]:disabled, [data-excerpt-open]:disabled")).toBeTruthy();
    expect(editor.getMarkdown()).toBe(source);
  } finally {
    editor.destroy();
    host.remove();
    setSystemClipboardWriter(null);
    window.noemaApi = originalApi;
    window.NoemaCurrentFile = originalNote;
    window.history.replaceState({}, "", oldUrl);
    vi.unstubAllGlobals();
  }
});
