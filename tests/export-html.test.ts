import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { cleanEditorHTML } from "../src/export-html.ts";

describe("HTML export sanitization", () => {
  test("removes editor chrome and unsafe attributes", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <p onclick="alert(1)">hello <a href="javascript:alert(1)">bad</a></p>
      <pre><code>body</code><div class="cb-chrome"><button>Copy</button></div></pre>
    `;
    const html = cleanEditorHTML(root);
    expect(html).toContain("<p>hello <a>bad</a></p>");
    expect(html).toContain("<pre><code>body</code></pre>");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("cb-chrome");
  });
});
