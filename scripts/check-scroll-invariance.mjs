// One scroll contract for every rendered construct, in a real browser.
//
// Clicking a construct (to edit it), clicking away from it, and clicking while
// the view is still scrolling must never move the viewport unless the click
// navigates. Each family used to have its own stability check (images,
// diagrams, rich scroll, pointer scroll); a fix for one regressed another.
// This walks every widget the editor draws over source, so a new family is
// covered without being listed.
//
//   NOEMA_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/check-scroll-invariance.mjs
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
const playwright = await import(process.env.NOEMA_PLAYWRIGHT_MODULE || "playwright");
const repo = fileURLToPath(new URL("../", import.meta.url));
const root = "/@fs" + repo;
const TOLERANCE = 2;

const prose = (n) => Array.from({ length: n }, (_, i) =>
  `Paragraph ${i}. Ordinary prose keeps the document long enough to scroll; `
  + "the old caret sits far outside the viewport. ".repeat(4)).join("\n\n");
const image = "data:image/svg+xml;base64," + Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="520"><rect width="320" height="520" fill="lightblue"/></svg>',
).toString("base64");
const constructs = [
  `An image ![Plot](${image}){width:320px} in a paragraph.`,
  "| name | value | note |\n|---|---|---|\n| alpha | \\(x^2\\) | first |\n| beta | 2 | second |\n"
    + Array.from({ length: 14 }, (_, i) => `| row ${i} | ${i} | more |`).join("\n"),
  "\\[\n\\int_0^1 f(x)\\,dx = \\sum_{k=0}^{n} a_k\n\\]",
  "Inline math \\(\\alpha + \\beta^2\\) inside a sentence, and a footnote[^1] too.",
  "#+begin theorem Main\nA statement with \\(x\\) in it.\n#+end theorem",
  "```python\nprint('hello')\nfor i in range(3):\n    print(i)\n```",
  "A task list:\n\n- [ ] open item\n- [x] done item",
  "---",
];
const wrapTables = ["left", "right"].map((side) =>
  `| wrap ${side} | formula |\n|---|---|\n| label | \\(z+1\\) |\n{align=${side} wrap=true width=40%}`);
const markdown = [prose(40), ...constructs.flatMap((c) => [c, prose(6)]),
  ...wrapTables.flatMap((c) => [c, prose(6)]), prose(40), "[^1]: The note."].join("\n\n");

const server = await createServer({
  configFile: repo + "vite.pages.config.ts", root: repo + "pages",
  logLevel: "error", server: { host: "127.0.0.1", port: 0, hmr: false },
});
await server.listen();
const failures = [];
try {
  for (const name of ["webkit", "chromium"]) {
    let browser;
    try { browser = await playwright[name].launch({ headless: true }); } catch (error) {
      console.log(`${name}: not installed, skipped`);
      continue;
    }
    try {
      const page = await browser.newPage({ viewport: { width: 1100, height: 820 } });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("**/@vite/client", (route) => route.fulfill({
        contentType: "application/javascript",
        body: "export function createHotContext(){return {accept(){},prune(){},dispose(){},on(){},invalidate(){}}} export function updateStyle(id,css){let s=document.createElement('style');s.textContent=css;document.head.append(s)} export function removeStyle(){} export function injectQuery(u){return u}",
      }));
      await page.route("**/scroll-invariance", (route) => route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html><head><link rel="stylesheet" href="${root}src/styles/widgets.css"><link rel="stylesheet" href="${root}pages/style.css"></head><body style="margin:0"><div id="host" class="noema-focused-editor" style="height:800px;width:1000px;overflow:auto;--noema-visual-zoom:1"></div></body></html>`,
      }));
      const appUrl = process.env.NOEMA_SCROLL_APP_URL;
      if (appUrl) {
        // The whole app, host focus handling included: NOEMA_SCROLL_APP_URL is a
        // running web host (web-host.mjs) and NOEMA_SCROLL_APP_FILE the note it
        // opens; the fixture is written there first.
        writeFileSync(process.env.NOEMA_SCROLL_APP_FILE, markdown);
        await page.goto(`${appUrl}/?file=${encodeURIComponent(process.env.NOEMA_SCROLL_APP_FILE)}`);
        await page.waitForFunction(() => document.querySelector(".cm-content")?.cmTile?.view?.state.doc.length > 1000, null, { timeout: 30_000 });
        await page.evaluate(() => {
          const view = document.querySelector(".cm-content").cmTile.view;
          let scroller = view.contentDOM.parentElement;
          while (scroller && !(scroller.scrollHeight > scroller.clientHeight + 10
            && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
          window.host = scroller;
          window.editor = {
            view,
            getMarkdown: () => view.state.doc.toString(),
            setMarkdownSelection: (at) => view.dispatch({ selection: { anchor: at } }),
          };
        });
      } else {
        await page.goto(new URL("scroll-invariance", server.resolvedUrls.local[0]).href);
        await page.evaluate(async ({ root, markdown }) => {
          const { createEditor } = await import(root + "src/editor-api.ts");
          window.host = document.querySelector("#host");
          window.editor = createEditor(host, { initialContent: markdown });
          await document.fonts.ready;
        }, { root, markdown });
      }
      await page.waitForTimeout(800);

      // Each construct by its source range; it is drawn once scrolled into view.
      const targets = [
        ["image", "![Plot]"], ["table", "| name |"], ["display math", "\\[\n\\int"],
        ["inline math", "\\(\\alpha"], ["org env", "#+begin theorem"],
        ["code block", "```python"], ["task box", "- [ ] open", "edits"], ["rule", "\n---\n"],
        ["footnote", "[^1] too", "navigates"],
      ].filter(([family]) => !process.env.ONLY || process.env.ONLY.split(",").includes(family)).map(([family, needle, click = "opens"]) => {
        const at = markdown.indexOf(needle);
        assert.ok(at >= 0, `fixture has ${family}`);
        const from = needle.startsWith("\n") ? at + 1 : at;
        // `opens`: the click edits it in place or shows its source; `edits`: the click
        // changes the document (a checkbox); `navigates`: the click moves the view on purpose.
        return { family, from, to: from + 40, click };
      });
      /** Put the construct at FROM mid-screen with the caret parked far away, as a reader who scrolled. */
      const scrollTo = async (from, caret) => {
        await page.evaluate(({ from, caret }) => {
          editor.setMarkdownSelection(caret.endsWith("end") ? editor.view.state.doc.length : 0);
          editor.view.focus();
          // "unfocused": the reader came from another window or a widget's own
          // field; the click has to bring focus back without revealing the old caret.
          if (caret.startsWith("unfocused")) editor.view.contentDOM.blur();
        }, { from, caret });
        await page.waitForTimeout(120);
        await page.evaluate((from) => {
          host.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
          const block = editor.view.lineBlockAt(from);
          host.scrollTop = Math.max(0, block.top - 300);
        }, from);
        await page.waitForTimeout(400);
      };
      /** The drawn element covering source [FROM, TO) and a click point inside it. */
      const locate = (from, to) => page.evaluate(({ from, to }) => {
        let best = null;
        for (const el of editor.view.contentDOM.querySelectorAll("[contenteditable=false]")) {
          if (el.parentElement?.closest("[contenteditable=false]")) continue;
          let at;
          try { at = editor.view.posAtDOM(el); } catch { continue; }
          if (at < from - 1 || at >= to) continue;
          const rect = el.getBoundingClientRect();
          if (rect.height < 4 || rect.width < 4) continue;
          if (!best || rect.width * rect.height > best.area) best = { el, rect, area: rect.width * rect.height };
        }
        if (!best) return null;
        const { rect, el } = best;
        // The line box, not a glyph: an opened construct shows text whose glyph
        // sits below the box top, which is not movement.
        const lineTop = editor.view.documentTop + editor.view.lineBlockAt(editor.view.state.doc.lineAt(from).from).top;
        // The middle: a corner can be a tool (a table toolbar button), not the construct.
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2,
          top: host.scrollTop, lineTop, cls: String(el.className).split(/\s+/)[0] };
      }, { from, to });
      /** Sample the viewport for MS after an action: every scrollTop it passed through. */
      const sample = (ms) => page.evaluate((ms) => new Promise((resolve) => {
        const seen = [host.scrollTop];
        const start = performance.now();
        const tick = () => {
          seen.push(host.scrollTop);
          if (performance.now() - start < ms) requestAnimationFrame(tick); else resolve(seen);
        };
        requestAnimationFrame(tick);
      }), ms);
      const record = (label, ok, detail) => {
        if (!ok) failures.push(`${name} ${label}: ${JSON.stringify(detail)}`);
        console.log(`${ok ? "ok  " : "FAIL"} ${name} ${label}`, ok ? "" : JSON.stringify(detail));
      };

      for (const { family, from, to, click } of targets) {
        for (const caret of ["start", "end", "unfocused start", "unfocused end"]) {
          // 1. Click the construct: it opens or edits; the line it starts on stays put.
          await scrollTo(from, caret);
          const before = await locate(from, to);
          if (!before) {
            const where = await page.evaluate((from) => ({
              scrollTop: host.scrollTop, wanted: Math.max(0, editor.view.lineBlockAt(from).top - 300),
              active: document.activeElement?.className || document.activeElement?.tagName,
            }), from);
            record(`${family} click (${caret})`, false, { notVisible: where });
            continue;
          }
          if (process.env.NOEMA_SCROLL_TRACE && caret.startsWith("unfocused")) await page.evaluate(() => {
            window.__trace = [];
            const view = editor.view;
            if (!window.__nativeTraced) {
              window.__nativeTraced = true;
              const log = (label) => window.__trace?.push(`${label} scrollTop=${host.scrollTop}\n` + new Error().stack.split("\n").slice(2, 9).join("\n"));
              const wrap = (proto, name) => {
                const original = proto[name];
                proto[name] = function (...args) { log(`${name} on ${this.className ?? this.constructor.name}`); const r = original.apply(this, args); log(`after ${name}`); return r; };
              };
              wrap(HTMLElement.prototype, "focus");
              wrap(Element.prototype, "scrollIntoView");
              for (const name of ["collapse", "setBaseAndExtent", "addRange", "removeAllRanges", "extend"]) wrap(Selection.prototype, name);
              host.addEventListener("scroll", () => log("SCROLL event"));
            }
            if (!view.__traced) {
              view.__traced = true;
              const original = view.dispatch.bind(view);
              view.dispatch = (...args) => {
                const spec = args[0];
                const scroll = spec && (spec.scrollIntoView || (spec.effects && [].concat(spec.effects).some((e) => String(e?.type?.map ?? "").includes("scroll") || e?.value?.isSnapshot !== undefined)));
                if (scroll || (spec && spec.scrollIntoView)) window.__trace?.push(new Error("scrolling dispatch").stack.split("\n").slice(1, 10).join("\n"));
                return original(...args);
              };
            }
          });
          const docBefore = await page.evaluate(() => editor.getMarkdown());
          await page.mouse.click(before.x, before.y);
          const path = await sample(700);
          if (process.env.NOEMA_SCROLL_TRACE && caret.startsWith("unfocused")) console.log("TRACE", family, caret, (await page.evaluate(() => window.__trace)).join("\n---\n"));
          const lineTop = await page.evaluate((from) =>
            editor.view.documentTop + editor.view.lineBlockAt(editor.view.state.doc.lineAt(from).from).top, from);
          const jumped = path.some((top) => Math.abs(top - before.top) > TOLERANCE && Math.abs(top - path.at(-1)) > TOLERANCE);
          if (click === "navigates") {
            // A jump is the one movement a click may cause; it must still happen.
            record(`${family} click navigates (old caret at ${caret})`, Math.abs(path.at(-1) - before.top) > 200,
              { before: before.top, after: path.at(-1) });
            continue;
          }
          record(`${family} click (old caret at ${caret})`,
            lineTop != null && Math.abs(lineTop - before.lineTop) <= TOLERANCE && !jumped,
            { before: before.top, after: path.at(-1), lineTopBefore: before.lineTop, lineTopAfter: lineTop, jumped });

          // 2. Click ordinary text elsewhere on screen: it stays under the pointer.
          await page.keyboard.press("Escape").catch(() => {});
          const text = await page.evaluate(() => {
            for (const line of editor.view.contentDOM.querySelectorAll(".cm-line")) {
              const node = [...line.childNodes].find((n) => n.nodeType === 3 && n.length > 30);
              if (!node) continue;
              const range = document.createRange();
              range.setStart(node, 10); range.setEnd(node, 11);
              const rect = range.getBoundingClientRect();
              if (rect.top < 120 || rect.bottom > 700 || !rect.width) continue;
              return { x: rect.left + 0.5, y: (rect.top + rect.bottom) / 2, top: rect.top, pos: editor.view.posAtDOM(node, 10) };
            }
            return null;
          });
          if (!text) continue;
          await page.mouse.click(text.x, text.y);
          await sample(600);
          const after = await page.evaluate((pos) => ({
            top: editor.view.coordsAtPos(pos)?.top ?? null, head: editor.view.state.selection.main.head,
          }), text.pos);
          const docAfter = await page.evaluate(() => editor.getMarkdown());
          if (click !== "edits") record(`${family} click and leave leave the document unchanged (${caret})`, docAfter === docBefore,
            { firstDifference: [...docAfter].findIndex((ch, i) => ch !== docBefore[i]),
              near: docAfter.slice(Math.max(0, [...docAfter].findIndex((ch, i) => ch !== docBefore[i]) - 20), [...docAfter].findIndex((ch, i) => ch !== docBefore[i]) + 40) });
          record(`${family} leave by clicking text (${caret})`,
            after.top != null && Math.abs(after.top - text.top) <= TOLERANCE && Math.abs(after.head - text.pos) <= 1,
            { textTop: text.top, after });
        }
      }

      // A table's inline formula opens a real CM6 cell. Its source line is
      // lower than the table widget's source position; anchoring that line
      // moved the whole page on entry. Leaving for prose below the table also
      // exposed a one-line mismatch in CM6's cached height map.
      if (!process.env.ONLY || process.env.ONLY.split(",").includes("table")) {
        const tableFrom = markdown.indexOf("| name |");
        await scrollTo(tableFrom, "unfocused start");
        await page.evaluate(() => {
          const table = document.querySelector(".cm-markdown-table-preview");
          host.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
          host.scrollTop += table.getBoundingClientRect().top - host.getBoundingClientRect().top - 100;
        });
        await page.waitForTimeout(400);
        const formulaPoint = await page.locator(
          ".cm-markdown-table-preview tbody tr:first-child td:nth-child(2) .noema-math-inline",
        ).boundingBox();
        assert.ok(formulaPoint, "table formula is rendered");
        const beforeFormula = await page.evaluate(() => host.scrollTop);
        await page.mouse.click(formulaPoint.x + formulaPoint.width / 2,
          formulaPoint.y + formulaPoint.height / 2);
        const formulaPath = await sample(500);
        const formulaOpen = await page.locator(".cm-table-source-active-cell .cm-math-inline-source").count();
        record("table formula opens in its cell without scrolling",
          formulaOpen > 0 && formulaPath.every((top) => Math.abs(top - beforeFormula) <= TOLERANCE),
          { before: beforeFormula, path: [...new Set(formulaPath.map(Math.round))], formulaOpen });

        await scrollTo(tableFrom, "start");
        await page.evaluate(() => {
          const table = document.querySelector(".cm-markdown-table-preview");
          host.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
          host.scrollTop += table.getBoundingClientRect().bottom - host.getBoundingClientRect().top - 560;
        });
        await page.waitForTimeout(400);
        const cellPoint = await page.locator(
          ".cm-markdown-table-preview tbody tr:last-child td:nth-child(2)",
        ).boundingBox();
        assert.ok(cellPoint, "last table row is rendered");
        const beforeCell = await page.evaluate(() => host.scrollTop);
        await page.mouse.click(cellPoint.x + cellPoint.width / 2,
          cellPoint.y + cellPoint.height / 2);
        const cellPath = await sample(500);
        const cellOpen = await page.locator(".cm-table-source-active-cell").count();
        record("table cell opens without scrolling",
          cellOpen > 0 && cellPath.every((top) => Math.abs(top - beforeCell) <= TOLERANCE),
          { before: beforeCell, path: [...new Set(cellPath.map(Math.round))], cellOpen });
        const afterTable = markdown.indexOf("Paragraph 0.", tableFrom) + 10;
        const prosePoint = await page.evaluate((pos) => {
          const rect = editor.view.coordsAtPos(pos);
          return rect ? { x: rect.left + 1, y: (rect.top + rect.bottom) / 2,
            top: rect.top, scrollTop: host.scrollTop } : null;
        }, afterTable);
        assert.ok(prosePoint && prosePoint.y < 800, "prose after table is visible");
        await page.mouse.click(prosePoint.x, prosePoint.y);
        const leavePath = await sample(500);
        const proseAfter = await page.evaluate((pos) => editor.view.coordsAtPos(pos)?.top, afterTable);
        record("table leaves for prose below without scrolling",
          leavePath.every((top) => Math.abs(top - prosePoint.scrollTop) <= TOLERANCE)
            && proseAfter != null && Math.abs(proseAfter - prosePoint.top) <= TOLERANCE,
          { before: prosePoint, path: [...new Set(leavePath.map(Math.round))], proseAfter });

        for (const side of ["left", "right"]) {
          const wrapFrom = markdown.indexOf(`| wrap ${side} |`);
          await scrollTo(wrapFrom, "start");
          await page.evaluate((side) => {
            const wrap = document.querySelector(`.cm-table-block.noema-table-wrap.noema-table-align-${side}`);
            host.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
            host.scrollTop += wrap.getBoundingClientRect().top - host.getBoundingClientRect().top - 200;
          }, side);
          await page.waitForTimeout(400);
          const wrapFormula = await page.locator(
            `.cm-table-block.noema-table-wrap.noema-table-align-${side} .cm-markdown-table-preview .noema-math-inline`,
          ).boundingBox();
          assert.ok(wrapFormula, `${side} wrapped table formula is visible`);
          const wrapBefore = await page.evaluate(() => host.scrollTop);
          await page.mouse.click(wrapFormula.x + wrapFormula.width / 2,
            wrapFormula.y + wrapFormula.height / 2);
          const wrapPath = await sample(500);
          const wrapOpen = await page.locator(".cm-table-source-active-cell .cm-math-inline-source").count();
          record(`${side} wrapped table formula opens without scrolling`,
            wrapOpen > 0 && wrapPath.every((top) => Math.abs(top - wrapBefore) <= TOLERANCE),
            { before: wrapBefore, path: [...new Set(wrapPath.map(Math.round))], wrapOpen });
          const wrapProsePos = markdown.indexOf("Paragraph 0.", wrapFrom) + 10;
          const wrapProse = await page.evaluate((pos) => {
            const rect = editor.view.coordsAtPos(pos);
            return rect ? { x: rect.left + 1, y: (rect.top + rect.bottom) / 2,
              top: rect.top, scrollTop: host.scrollTop } : null;
          }, wrapProsePos);
          assert.ok(wrapProse && wrapProse.y > 0 && wrapProse.y < 800,
            `${side} wrapped table has visible adjacent prose`);
          await page.mouse.click(wrapProse.x, wrapProse.y);
          const wrapLeavePath = await sample(500);
          const wrapProseAfter = await page.evaluate((pos) => editor.view.coordsAtPos(pos)?.top, wrapProsePos);
          record(`${side} wrapped table leaves without scrolling`,
            wrapLeavePath.every((top) => Math.abs(top - wrapProse.scrollTop) <= TOLERANCE)
              && wrapProseAfter != null && Math.abs(wrapProseAfter - wrapProse.top) <= TOLERANCE,
            { before: wrapProse, path: [...new Set(wrapLeavePath.map(Math.round))], wrapProseAfter });
        }
      }

      // 3. Click while still scrolling (trackpad momentum sends scroll events
      // without wheel events): the scroll that follows the click wins.
      for (const { family, from, to } of targets.slice(0, 4)) {
        await scrollTo(from, "start");
        const start = await page.evaluate(() => host.scrollTop);
        const target = await locate(from, to);
        if (!target) continue;
        await page.evaluate(() => {
          window.__momentum = (async () => {
            for (let i = 0; i < 24; i++) {
              host.scrollTop += 12;
              await new Promise((r) => requestAnimationFrame(r));
            }
            window.__momentumEnd = host.scrollTop;
          })();
        });
        await page.waitForTimeout(60);
        await page.mouse.click(target.x, target.y - 0);
        await page.evaluate(() => window.__momentum);
        await sample(500);
        const end = await page.evaluate(() => ({ top: host.scrollTop, expected: window.__momentumEnd }));
        record(`${family} click during momentum scroll`,
          Math.abs(end.top - end.expected) <= TOLERANCE && end.top > start + 40,
          { start, ...end });
      }
      // WebKit reports a benign ResizeObserver loop while measured widgets settle.
      // 5. Click the visible lower part of a construct whose top is above the
      // viewport (a tall image, table or diagram): nothing scrolls to its top.
      for (const { family, from, to, click } of targets) {
        if (click === "navigates") continue;
        await scrollTo(from, "start");
        const tall = await page.evaluate(({ from, to }) => {
          for (const el of editor.view.contentDOM.querySelectorAll("[contenteditable=false]")) {
            if (el.parentElement?.closest("[contenteditable=false]")) continue;
            let at;
            try { at = editor.view.posAtDOM(el); } catch { continue; }
            if (at < from - 1 || at >= to) continue;
            const rect = el.getBoundingClientRect();
            if (rect.height < 120) continue;
            const hostTop = host.getBoundingClientRect().top;
            host.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
            host.scrollTop += rect.top - hostTop + 60;  // its top 60px above the viewport
            return true;
          }
          return false;
        }, { from, to });
        if (!tall) continue;
        await page.waitForTimeout(400);
        const point = await page.evaluate(({ from, to }) => {
          for (const el of editor.view.contentDOM.querySelectorAll("[contenteditable=false]")) {
            if (el.parentElement?.closest("[contenteditable=false]")) continue;
            let at;
            try { at = editor.view.posAtDOM(el); } catch { continue; }
            if (at < from - 1 || at >= to) continue;
            const rect = el.getBoundingClientRect();
            if (rect.height < 120) continue;
            return { x: rect.left + rect.width / 2, y: Math.min(rect.bottom - 20, host.getBoundingClientRect().bottom - 40),
              top: host.scrollTop };
          }
          return null;
        }, { from, to });
        if (!point) continue;
        await page.mouse.click(point.x, point.y);
        const path = await sample(800);
        record(`${family} click on its lower part, top off screen`,
          path.every((top) => Math.abs(top - point.top) <= TOLERANCE),
          { before: point.top, path: [...new Set(path.map(Math.round))] });
        await page.keyboard.press("Escape").catch(() => {});
      }

      // 4. Scroll soon after a click by a path with no wheel event (an Emacs
      // scroll command, the tail of trackpad momentum): the scroll stands.
      for (const { family, from, to, click } of targets) {
        if (click === "navigates") continue;
        await scrollTo(from, "start");
        const target = await locate(from, to);
        if (!target) continue;
        await page.mouse.click(target.x, target.y);
        await page.waitForTimeout(250);
        await page.evaluate(async () => {
          for (let i = 0; i < 10; i++) {
            host.scrollTop += 40;
            await new Promise((r) => requestAnimationFrame(r));
          }
          window.__scrolledTo = host.scrollTop;
        });
        const path = await sample(1200);
        const expected = await page.evaluate(() => window.__scrolledTo);
        record(`${family} scroll without wheel right after a click`,
          path.every((top) => Math.abs(top - expected) <= TOLERANCE),
          { expected, path: [...new Set(path.map(Math.round))] });
        await page.keyboard.press("Escape").catch(() => {});
      }
      assert.deepEqual(errors.filter((message) => !message.startsWith("ResizeObserver loop")), [], `${name}: page errors`);
    } finally { await browser.close(); }
  }
} finally { await server.close(); }
if (failures.length) {
  console.error(`\n${failures.length} scroll contract violation(s):\n${failures.join("\n")}`);
  process.exit(1);
}
console.log("\nscroll contract holds for every construct family");
