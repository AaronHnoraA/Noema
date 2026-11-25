import { expect, test } from "@voidzero-dev/vite-plus-test";
import { createEditor } from "../src/editor-api.ts";
import { renderMarkdownHTML } from "../src/render-html.ts";

function render(source: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = renderMarkdownHTML(source);
  return root;
}

test("parameter documentation preserves the body and declares the type, default, and status", () => {
  const root = render([
    '#+begin field 布局 {name=width type=number type-link=types.md default=46 required=true since=0.1 experimental="Responsive layout" enum="8 | 16 | 46" unit=列 format=integer constraint="8 ≤ width ≤ 120"}',
    "Markdown **description**.",
    "#+end field",
  ].join("\n"));
  const field = root.querySelector(".noema-parameter-field")!;
  expect(field.querySelector(".noema-field-name")?.textContent).toBe("width");
  expect(field.querySelector("a[href='types.md']")?.textContent).toBe("number");
  expect(field.querySelector("[data-field-state='required']")?.textContent).toBe("Required");
  expect(field.querySelector("[data-field-state='experimental']")?.textContent).toContain("Responsive layout");
  expect(field.querySelector(".noema-field-default")?.textContent).toBe("46");
  expect(field.querySelector(".noema-field-values")?.textContent).toContain("8 ≤ width ≤ 120");
  expect(field.querySelector("strong")?.textContent).toBe("description");
  expect(render('#+begin field {name=width type=number type-link="javascript:alert(1)"}\n#+end field').querySelector(".noema-parameter-field a")).toBeNull();
});

test("fields composed only of attributes appear in the visual editor", () => {
  const source = "#+begin field {name=width default=46}\n#+end field\n\nLater.";
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent: source });
  try {
    editor.setMarkdownSelection(source.length);
    expect(host.querySelector(".noema-field-name")?.textContent).toBe("width");
    expect(host.querySelector(".noema-field-default")?.textContent).toBe("46");
    editor.setMarkdownSelection(source.indexOf("default"));
    expect(host.querySelector(".noema-field-name")).toBeNull();
    expect(editor.getMarkdown()).toBe(source);
  } finally {
    editor.destroy();
    host.remove();
  }
});

test("field and form lists split names from values while retaining inline markup", () => {
  for (const kind of ["field", "form"]) {
    const source = [
      `#+begin ${kind} 环境`, '- 版本：**12.3.0**', '- 渲染器: [WebKit](engine.md)',
      '- 入口: `config: ready`', '- [Tag: label](tag.md): details', `#+end ${kind}`,
    ].join("\n");
    const root = render(source);
    expect([...root.querySelectorAll(".noema-document-fields dt")].map((term) => term.textContent)).toEqual(["版本", "渲染器", "入口", "Tag: label"]);
    expect(root.querySelector("dd strong")?.textContent).toBe("12.3.0");
    expect(root.querySelector("dd a")?.getAttribute("href")).toBe("engine.md");
    expect(root.querySelector("dd code")?.textContent).toBe("config: ready");
    expect(root.querySelector("input, textarea, form")).toBeNull();
    const invalid = render(source.replace("- 版本：**12.3.0**", "- **Ordinary Markdown**"));
    expect(invalid.querySelector("ul strong")?.textContent).toBe("Ordinary Markdown");
  }
});

test("escaped separators in field names remain literal and inline linkification still runs", () => {
  const source = "#+begin form\n- host\\:port: www.example.com\n- host&#58;port: another value\n#+end form";
  const root = render(source);
  expect([...root.querySelectorAll("dt")].map((term) => term.textContent)).toEqual(["host:port", "host:port"]);
  expect(root.querySelector("dd a")?.getAttribute("href")).toBe("http://www.example.com");
});
