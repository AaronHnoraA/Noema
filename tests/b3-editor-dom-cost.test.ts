/**
 * The b3 adapter must not walk CodeMirror's DOM.
 *
 * `installB3ComponentSystem` observes `document.body` with `subtree: true`, so
 * every CodeMirror viewport rewrite — every scroll and every keystroke — hands
 * it the newly inserted subtree. Its candidate selector used to end in a bare
 * `[class]`, so each rewrite materialised and classified every classed
 * descendant: on a formula-dense note that is thousands of KaTeX spans per
 * rewrite, inside a microtask checkpoint that the page cannot yield out of.
 *
 * Editor content can never be a b3 surface, so the correct number of elements
 * to classify there is zero — while real surfaces are still adopted.
 */

import { expect, test } from "@voidzero-dev/vite-plus-test";

import { installB3ComponentSystem } from "../src/b3-component-system.ts";

/** One CodeMirror line carrying rendered KaTeX, which is all classed spans. */
function formulaLine(index: number): HTMLElement {
  const line = document.createElement("div");
  line.className = "cm-line";
  let html = `<span class="cm-heading">Line ${index}</span> `;
  for (let i = 0; i < 40; i++) {
    html += '<span class="katex"><span class="katex-mathml"><span class="mord">A</span></span>'
      + '<span class="katex-html"><span class="base"><span class="strut"></span>'
      + '<span class="mord mathnormal">u</span><span class="msupsub"><span class="vlist-t">'
      + '<span class="vlist-r"><span class="vlist"><span class="pstrut"></span>'
      + '<span class="sizing reset-size6 size3 mtight"><span class="mord mtight">i</span></span>'
      + '</span></span></span></span></span></span> ';
  }
  line.innerHTML = html;
  return line;
}

async function nextTask(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

test("a viewport rewrite classifies no editor elements, and still adopts real surfaces", async () => {
  const root = document.createElement("div");
  document.body.append(root);
  const stop = installB3ComponentSystem(root);
  const editor = document.createElement("div");
  editor.className = "cm-editor";
  root.append(editor);
  await nextTask();

  let visited = 0;
  const realQuerySelectorAll = Element.prototype.querySelectorAll;
  Element.prototype.querySelectorAll = function (this: Element, selector: string) {
    const found = realQuerySelectorAll.call(this, selector);
    visited += found.length;
    return found as ReturnType<typeof realQuerySelectorAll>;
  };
  let nodes = 0;
  try {
    for (let i = 0; i < 25; i++) editor.append(formulaLine(i));
    await nextTask();
    nodes = realQuerySelectorAll.call(editor, "*").length;
  } finally {
    Element.prototype.querySelectorAll = realQuerySelectorAll;
  }

  expect(nodes).toBeGreaterThan(10_000);
  expect(visited).toBe(0);

  const panel = document.createElement("aside");
  panel.className = "aaronnote-jupyter-panel";
  root.append(panel);
  const button = document.createElement("button");
  button.textContent = "Refresh";
  panel.append(button);
  await nextTask();
  expect(panel.classList.contains("b3-panel")).toBe(true);
  expect(button.classList.contains("b3-button")).toBe(true);

  stop();
  root.remove();
});
