import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { renderSearchExcerpt } from "../aaronnote/search-excerpt.ts";

function render(excerpt: string, query: string): HTMLElement {
  const host = document.createElement("p");
  renderSearchExcerpt(host, excerpt, query);
  return host;
}

describe("search excerpt", () => {
  test("marks the free-text terms and ignores the index brackets and filters", () => {
    const host = render(" … see [[Group]] theory and [[Ring Theory]] …", "group tag:math -ring");
    expect(host.textContent).toBe(" … see Group theory and Ring Theory …");
    expect([...host.querySelectorAll("mark")].map((mark) => mark.textContent)).toEqual(["Group"]);
  });

  test("marks CJK terms and prefers the longest term at a position", () => {
    const host = render("群论是代数的分支，同构保持结构", "群 群论 同构");
    expect([...host.querySelectorAll("mark")].map((mark) => mark.textContent)).toEqual(["群论", "同构"]);
  });

  test("never interprets excerpt text as markup", () => {
    const host = render("<img src=x onerror=alert(1)> plain", "plain img");
    expect(host.querySelector("img")).toBeNull();
    expect(host.textContent).toBe("<img src=x onerror=alert(1)> plain");
    expect(host.querySelectorAll("mark")).toHaveLength(2);
  });

  test("shows the text unmarked without free-text terms", () => {
    const host = render("Plain [[text]]", "tag:math");
    expect(host.childNodes).toHaveLength(1);
    expect(host.textContent).toBe("Plain text");
  });
});
