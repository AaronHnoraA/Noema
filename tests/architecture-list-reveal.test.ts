/**
 * Architecture guard: moving through a popup list scrolls only that list.
 * `element.scrollIntoView()` scrolls every scrollable ancestor, so arrowing
 * through a completion, reference, search or tag list near a screen edge made
 * the editor or page jump. Lists use pages/list-reveal.ts.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

/** Places where scrolling the page to an element is the point, with reasons. */
const PAGE_SCROLLS: Record<string, string> = {
  "pages/agenda-view.ts": "the Agenda is a full page; its cursor row moves the page",
  "pages/jupyter-main.ts": "a full Jupyter page jumping to a cell",
  "pages/main.ts": "horizontal tab strip of the LiveTeX palette, and the bibliography panel item",
};

describe("popup lists scroll only themselves", () => {
  test("no page code reveals a row with element.scrollIntoView", () => {
    const offenders: string[] = [];
    for (const name of readdirSync(join(process.cwd(), "pages"))) {
      if (!name.endsWith(".ts")) continue;
      const file = `pages/${name}`;
      if (PAGE_SCROLLS[file] || file === "pages/list-reveal.ts") continue;
      const code = readFileSync(join(process.cwd(), file), "utf8").replace(/\/\/[^\n]*/g, "");
      if (/\.scrollIntoView\(\s*\{/.test(code)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  test("revealInList moves the list and nothing above it", async () => {
    const { revealInList } = await import("../pages/list-reveal.ts");
    const list = document.createElement("div");
    const row = document.createElement("div");
    list.append(row);
    document.body.append(list);
    Object.defineProperty(list, "clientHeight", { value: 100 });
    Object.defineProperty(list, "scrollHeight", { value: 400 });
    list.getBoundingClientRect = () => ({ top: 0, bottom: 100, height: 100, left: 0, right: 0, width: 0, x: 0, y: 0, toJSON() {} });
    row.getBoundingClientRect = () => ({ top: 150, bottom: 180, height: 30, left: 0, right: 0, width: 0, x: 0, y: 0, toJSON() {} });
    const pageScroll = window.scrollY;
    revealInList(list, row);
    expect(list.scrollTop).toBe(80);
    expect(window.scrollY).toBe(pageScroll);
    list.remove();
  });
});
