import { expect, test } from "@voidzero-dev/vite-plus-test";
import { createEditor } from "../src/editor-api.ts";
import { renderMarkdownHTML } from "../src/render-html.ts";
import { setSystemClipboardWriter } from "../src/system-clipboard.ts";

function chat(source: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = renderMarkdownHTML(`#+begin chat 复盘\n${source}\n#+end chat`);
  return root;
}

test("chat keeps conversation order, message authors, Markdown content, and date rows", () => {
  const root = chat([
    "### 2026-11-26 10:30 {timestamp=true}",
    "### Lin", "Did you read the [guide](guide.md)?",
    "### 编辑者 {self=true}", "Yes. The reading frame is ready.", "",
    "~~~text", "### literal heading", "~~~",
    "### Lin", "> A helpful note.",
  ].join("\n"));
  const conversation = root.querySelector(".noema-document-chat")!;
  expect(conversation.querySelector(".noema-chat-time")?.textContent).toBe("2026-11-26 10:30");
  expect([...conversation.querySelectorAll(".noema-chat-author")].map((item) => item.textContent)).toEqual(["Lin", "编辑者", "Lin"]);
  expect(conversation.querySelector("[data-chat-side='self'] pre code")?.textContent).toBe("### literal heading\n");
  expect(conversation.querySelector("a")?.getAttribute("href")).toBe("guide.md");
  expect(conversation.querySelector("blockquote")?.textContent).toContain("A helpful note.");
});

test("chat keeps its preamble and falls back to ordinary Markdown without messages", () => {
  const decorated = chat("Introductory **context**.\n\n### Wei\nMessage.");
  expect(decorated.querySelector(".noema-document-chat strong")?.textContent).toBe("context");
  const regular = chat("Ordinary **Markdown**.");
  expect(regular.querySelector(".noema-document-chat")).toBeNull();
  expect(regular.querySelector("strong")?.textContent).toBe("Markdown");
});

test("the editor copies the whole conversation as authored and publication only carries its rendered messages", async () => {
  const body = "### 10:00 {timestamp=true}\n### Lin\nKeep the {==approved==}{>>#c-abcd<<} note.\n### Me {self=true}\nReady.\n";
  const chatSource = `#+begin chat Review\n${body}#+end chat`;
  const quote = chatSource.split("\n").map((line) => `> ${line}`).join("\n");
  const source = `#+begin window Frame\n${quote}\n#+end window\n\nAfter.`;
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent: source });
  let copied = "";
  setSystemClipboardWriter(async (text) => { copied = text; return true; });
  try {
    editor.setMarkdownSelection(source.length);
    await Promise.resolve();
    host.querySelector<HTMLButtonElement>("[data-document-source-copy]")!.click();
    expect(copied).toBe(body);
    const published = renderMarkdownHTML(source);
    expect(published).not.toContain("data-document-source-body");
    expect(published).not.toContain("#c-abcd");
    expect(published).toContain("Keep the approved note.");
  } finally {
    setSystemClipboardWriter(null);
    editor.destroy();
    host.remove();
  }
});
