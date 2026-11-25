import { expect, test, vi } from "@voidzero-dev/vite-plus-test";
import { createEditor } from "../src/editor-api.ts";
import { renderMarkdownHTML } from "../src/render-html.ts";

test("a live tree restores its folder after refresh and source reveal", async () => {
  const previousApi = window.noemaApi;
  const previousFile = window.NoemaCurrentFile;
  const file = (label: string, key: string) => ({ label, key, file: `/fixture/${key}`, directory: false, children: [] });
  const projectTree = vi.fn(async () => ({ ok: true, label: "fixture/", truncated: false, entries: [
    { label: "src", key: "src", file: "/fixture/src", directory: true, children: [file("main.ts", "src/main.ts")] },
  ] }));
  const open = vi.fn(async () => ({ ok: true }));
  vi.stubGlobal("IntersectionObserver", undefined);
  window.NoemaCurrentFile = () => "/fixture/note.md";
  window.noemaApi = {documentAssets:{projectTree}, emacs:{open}};
  const host = document.createElement("div");
  document.body.append(host);
  const source = '#+begin project-tree Fixture {depth=2 open-depth=0}\n#+end project-tree\n\nAfter.';
  const editor = createEditor(host, {initialContent:source});
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const folder = () => host.querySelector<HTMLDetailsElement>(".noema-project-tree details");
  try {
    editor.setMarkdownSelection(source.length);
    await tick();
    expect(projectTree).toHaveBeenCalledWith(expect.objectContaining({notePath:"/fixture/note.md", depth:"2"}));
    expect(folder()?.open).toBe(false);
    folder()?.querySelector("summary")?.click();
    expect(folder()?.open).toBe(true);
    folder()?.querySelector("button")?.click();
    expect(open).toHaveBeenCalledWith({file:"/fixture/src/main.ts"});
    host.querySelector<HTMLButtonElement>("[data-project-refresh]")?.click();
    await tick();
    expect(folder()?.open).toBe(true);
    editor.setMarkdownSelection(source.indexOf("Fixture"));
    expect(folder()).toBeNull();
    editor.setMarkdownSelection(source.length);
    await tick();
    expect(folder()?.open).toBe(true);
    expect(editor.getMarkdown()).toBe(source);
    expect(renderMarkdownHTML(source)).not.toContain("main.ts");
    expect(renderMarkdownHTML(source)).not.toContain("data-project-path");
  } finally {
    editor.destroy();
    host.remove();
    window.noemaApi = previousApi;
    window.NoemaCurrentFile = previousFile;
    vi.unstubAllGlobals();
  }
});
