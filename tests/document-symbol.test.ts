import { expect, test, vi } from "@voidzero-dev/vite-plus-test";
import { createEditor } from "../src/editor-api.ts";
import { renderMarkdownHTML } from "../src/render-html.ts";

test("live Emacs symbol cards use native actions and publish only authored material", async () => {
  const previousApi = window.noemaApi;
  const previousFile = window.NoemaCurrentFile;
  const lookup = vi.fn(async (input: unknown) => {
    const { name, action } = input as { name: string; action: string };
    if (action !== "inspect") return {ok:true};
    return name === "fixture-command"
      ? {ok:true, found:true, kind:"Command", keys:["C-c f"], signature:"(fixture-command name)", summary:"Live summary", file:"sample.el"}
      : {ok:true, found:false};
  });
  vi.stubGlobal("IntersectionObserver", undefined);
  window.noemaApi = {documentAssets:{symbol:lookup}};
  window.NoemaCurrentFile = () => "/fixture/symbols.md";
  const host = document.createElement("div");
  document.body.append(host);
  const source = "#+begin symbol Entry {name=fixture-command}\nStatic introduction.\n#+end symbol\n\n"
    + "#+begin symbol Missing {name=fixture-missing}\nFallback content.\n#+end symbol\n\nAfter.";
  const editor = createEditor(host, {initialContent:source});
  try {
    editor.setMarkdownSelection(source.length);
    await vi.waitFor(() => expect(host.querySelector(".noema-symbol-signature")?.textContent).toBe("(fixture-command name)"));
    const loaded = host.querySelector<HTMLElement>('[data-emacs-symbol="fixture-command"]')!;
    const missing = host.querySelector<HTMLElement>('[data-emacs-symbol="fixture-missing"]')!;
    expect(loaded.querySelector("kbd")?.textContent).toBe("C-c f");
    expect(loaded.querySelector<HTMLElement>(".noema-excerpt-fallback")?.hidden).toBe(true);
    expect(missing.querySelector<HTMLElement>(".noema-excerpt-fallback")?.hidden).toBe(false);
    expect(missing.querySelector<HTMLElement>(".noema-excerpt-actions")?.hidden).toBe(true);
    loaded.querySelector<HTMLButtonElement>("[data-symbol-help]")!.click();
    loaded.querySelector<HTMLButtonElement>("[data-symbol-definition]")!.click();
    expect(lookup).toHaveBeenCalledWith({name:"fixture-command", action:"help"});
    expect(lookup).toHaveBeenCalledWith({name:"fixture-command", action:"definition"});
    window.NoemaCurrentFile = () => "/fixture/other.md";
    lookup.mockClear();
    loaded.querySelector<HTMLButtonElement>("[data-symbol-help]")!.click();
    expect(lookup).not.toHaveBeenCalled();
    expect(editor.getMarkdown()).toBe(source);
    const published = renderMarkdownHTML(source);
    expect(published).toContain("fixture-command");
    expect(published).toContain("Static introduction.");
    expect(published).toContain("Fallback content.");
    expect(published).not.toMatch(/Live summary|data-emacs-symbol/);
  } finally {
    editor.destroy();
    host.remove();
    window.noemaApi = previousApi;
    window.NoemaCurrentFile = previousFile;
    vi.unstubAllGlobals();
  }
});
