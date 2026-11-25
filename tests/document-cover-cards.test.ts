import { expect, test } from "@voidzero-dev/vite-plus-test";
import { createEditor } from "../src/editor-api.ts";
import { renderMarkdownHTML } from "../src/render-html.ts";

const home = '#+begin home-box 项目入口 {description="查看 **渲染手册**" accent=info href="#guide" action="阅读指南"}\n从一个简单样例开始。\n#+end home-box';
const link = '#+begin link-card 交互清单 {description="支持 [快捷键](keys.md) 和焦点。"}\n[打开 **清单**](guide.md)\n\n还有 [更多](more.md)。\n#+end link-card';

function render(markdown: string, assetResolver?: (path: string) => string) {
  const root = document.createElement("div");
  root.innerHTML = renderMarkdownHTML(markdown, { assetResolver });
  return root;
}

test("home cards preserve the org environment with a summary and primary action", () => {
  const root = render(home);
  const frame = root.querySelector(".noema-document-frame[data-frame=home-box]");
  expect(root.querySelector("org-env-block")?.getAttribute("data-title")).toBe("项目入口");
  expect(frame?.getAttribute("data-accent")).toBe("info");
  expect(frame?.querySelector(".noema-document-card-action")?.getAttribute("href")).toBe("#guide");
  expect(frame?.querySelector(".noema-document-card-description strong")?.textContent).toBe("渲染手册");
  expect(frame?.querySelector(".noema-document-frame-body p")?.textContent).toBe("从一个简单样例开始。");
});

test("link cards promote a Markdown link and retain independent links", () => {
  const root = render(link);
  const frame = root.querySelector(".noema-document-frame[data-frame=link-card]");
  const primary = frame?.querySelector(".noema-document-card-action");
  expect(primary?.getAttribute("href")).toBe("guide.md");
  expect(primary?.querySelector("strong")?.textContent).toBe("清单");
  expect([...frame!.querySelectorAll("a")].map((node) => node.getAttribute("href")).sort()).toEqual(["guide.md", "keys.md", "more.md"]);
  expect(render('#+begin link-card Link {href="javascript:alert(1)"}\nOther text.\n#+end link-card').querySelector("a")).toBeNull();
  const invalid = render("#+begin link-card Invalid\n[No](javascript:alert(1))\n\nBody.\n#+end link-card");
  expect(invalid.querySelector("[data-card-link], .noema-document-card-action")).toBeNull();
  expect(invalid.querySelector(".noema-document-frame-body")?.textContent).toContain("Body.");
});

test("image cards render a leading Markdown cover through the normal asset resolver", () => {
  const root = render('#+begin image-card 窄窗 {description="布局示例" href="guide.md"}\n![预览界面][cover]\n\n正文。\n\n[cover]: media/cover.png\n#+end image-card', (path) => "/files/" + path);
  const frame = root.querySelector(".noema-document-frame[data-frame=image-card]");
  const cover = frame?.querySelector(".noema-document-card-cover img");
  expect(cover?.getAttribute("alt")).toBe("预览界面");
  expect(cover?.getAttribute("src")).toBe("/files/media/cover.png");
  expect(frame?.querySelector(".noema-document-frame-body p")?.textContent).toBe("正文。");
  expect(frame?.querySelector(".noema-document-card-action")?.getAttribute("href")).toBe("guide.md");
  const invalid = render("#+begin image-card Invalid\n![Invalid](javascript:alert(1))\n#+end image-card");
  expect(invalid.querySelector(".noema-document-card-cover")).toBeNull();
});

test("an image card also accepts a short source and alternative text", () => {
  const root = render('#+begin image-card Cover {src="media/simple.png" alt="An illustrated cover"}\n#+end image-card');
  expect(root.querySelector(".noema-document-card-cover img")?.getAttribute("src")).toBe("media/simple.png");
  expect(root.querySelector(".noema-document-card-cover img")?.getAttribute("alt")).toBe("An illustrated cover");
  expect(render('#+begin image-card Cover {src="javascript:alert(1)" alt="Cover"}\nBody text.\n#+end image-card').querySelector("img")).toBeNull();
});

test("a metadata-only card and independent card links open through the editor's host", () => {
  const source = `#+begin link-card Reader {href="https://example.com/guide" action="Read"}\n#+end link-card\n\n${link}\n\nNext.`;
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent: source });
  const opened: string[] = [];
  editor.view.dom.addEventListener("noema:open-url", (event) => {
    event.preventDefault();
    opened.push((event as CustomEvent<{ href: string }>).detail.href);
  });
  try {
    editor.setMarkdownSelection(source.length);
    const action = host.querySelector<HTMLAnchorElement>(".noema-document-card-action");
    expect(action).not.toBeNull();
    action?.click();
    host.querySelector<HTMLAnchorElement>("a[href='keys.md']")?.click();
    host.querySelector<HTMLAnchorElement>("a[href='more.md']")?.click();
    expect(opened).toEqual(["https://example.com/guide", "keys.md", "more.md"]);
    expect(editor.getMarkdown()).toBe(source);
  } finally {
    editor.destroy();
    host.remove();
  }
});
