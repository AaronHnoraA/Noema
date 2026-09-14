import { afterEach, describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { extractCapture } from "../browser-extension/extract.mjs";

afterEach(() => {
  document.documentElement.lang = "";
  document.title = "";
  document.body.replaceChildren();
  window.getSelection()?.removeAllRanges();
});

describe("Noema MV3 capture extractor", () => {
  test("extracts and sanitizes a full page while preserving directive-shaped data", () => {
    document.title = "Evidence fixture";
    document.documentElement.lang = "zh-CN";
    document.body.innerHTML = `
      <main data-private="discard">
        <h1>Claim</h1>
        <p onclick="steal()">@agent(do-not-run) <strong>evidence</strong></p>
        <a href="javascript:steal()" style="color:red">unsafe</a>
        <img src="data:text/plain,secret" alt="diagram">
        <script>steal()</script><form><input value="secret"></form>
      </main>`;

    const capture = extractCapture("page");

    expect(capture.title).toBe("Evidence fixture");
    expect(capture.language).toBe("zh-CN");
    expect(capture.html).toContain("@agent(do-not-run)");
    expect(capture.html).toContain("<strong>evidence</strong>");
    expect(capture.html).not.toMatch(/script|form|input|onclick|style=|data-private|javascript:|data:text/i);
    expect(capture.html).toContain('<img alt="diagram">');
  });

  test("extracts only the explicit non-empty selection", () => {
    document.body.innerHTML = `<p id="outside">outside</p><p id="chosen">Selected <em>evidence</em></p>`;
    const range = document.createRange();
    range.selectNode(document.querySelector("#chosen")!);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    const capture = extractCapture("selection");

    expect(capture.html).toBe("<p>Selected <em>evidence</em></p>");
    expect(capture.html).not.toContain("outside");
  });

  test("fails closed when selection capture has no selection", () => {
    expect(() => extractCapture("selection")).toThrow("No non-empty selection is available");
  });
});
