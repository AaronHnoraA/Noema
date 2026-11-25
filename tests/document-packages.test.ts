import { expect, test } from "@voidzero-dev/vite-plus-test";
import { packageManagerScript } from "../src/package-commands.ts";
import { createEditor } from "../src/editor-api.ts";
import { renderMarkdownHTML } from "../src/render-html.ts";
import { setSystemClipboardWriter } from "../src/system-clipboard.ts";

test("package commands preserve versions, scope, and literal shell arguments", () => {
  const source = "  npm i -D @scope/tool@1.2.3 && npm run check -- '--label=a && b'\n# keep\nnpx vite@latest --help\n";
  expect(packageManagerScript(source, "npm")).toBe(source);
  expect(packageManagerScript(source, "pnpm")).toBe("  pnpm add -D @scope/tool@1.2.3 && pnpm run check '--label=a && b'\n# keep\npnpm dlx vite@latest --help\n");
  expect(packageManagerScript(source, "yarn")).toBe("  yarn add -D @scope/tool@1.2.3 && yarn run check '--label=a && b'\n# keep\nyarn dlx vite@latest --help\n");
  expect(packageManagerScript(source, "deno")).toBe("  deno add -D npm:@scope/tool@1.2.3 && deno task check '--label=a && b'\n# keep\ndeno x npm:vite@latest --help\n");
});

test("recognized installs and creation coexist with unsupported commands", () => {
  const source = "npm install\nnpm ci\nnpm create vite@latest example\nnpm install -g example\necho \"npm i hidden\"\n";
  expect(packageManagerScript(source, "bun")).toBe("bun install\nbun install --frozen-lockfile\nbun create vite@latest example\nnpm install -g example\necho \"npm i hidden\"\n");
  expect(packageManagerScript(source, "deno")).toBe("deno install\ndeno ci\ndeno create npm:vite@latest example\nnpm install -g example\necho \"npm i hidden\"\n");
});

test("compound and multiline shell structures retain their exact source", () => {
  for (const source of [
    "cat <<EOF\nnpm install sample\nEOF\n",
    "printf '%s' \\\nnpm install sample\n",
    "if enabled; then\nnpm install sample\nfi\n",
    "npm install sample | tee log\nnpm run check\n",
  ]) {
    expect(packageManagerScript(source, "pnpm")).toBe(source);
  }
});

test("package-manager flags follow each tool and npm-only script flags keep the source", () => {
  const source = "npm install --save-exact --save-optional tool@1.2\nnpm create vite app -- --template react\nnpm run build --watch\n";
  expect(packageManagerScript(source, "bun")).toBe("bun add --optional -E tool@1.2\nbun create vite app --template react\nnpm run build --watch\n");
  expect(packageManagerScript(source, "deno")).toBe("deno add -O --save-exact npm:tool@1.2\ndeno create npm:vite app -- --template react\nnpm run build --watch\n");
});

test("shell quoting and escaping do not turn npm options into script arguments", () => {
  for (const opts of ["'--silent'", '"--silent"', "\\-\\-silent", '"$NPM_ARGS"']) {
    const run = `npm run check ${opts}`;
    expect(packageManagerScript(run, "pnpm")).toBe(run);
    const create = `npm create vite app ${opts}`;
    expect(packageManagerScript(create, "deno")).toBe(create);
  }
  expect(packageManagerScript("npm run check '--' '--silent'", "pnpm")).toBe("pnpm run check '--silent'");
});

test("package badge uses authored metadata and published command tabs contain every selected tool", () => {
  const source = [
    '#+begin npm-badge {name=@scope/tool version=v1.2.3 downloads="120 / week"}', "#+end npm-badge", "",
    '#+begin npm-to Shell {tabs="npm, pnpm, deno"}', "~~~sh", "npm i @scope/tool", "~~~", "#+end npm-to",
  ].join("\n");
  const root = document.createElement("div");
  root.innerHTML = renderMarkdownHTML(source);
  const badge = root.querySelector(".noema-package-badge");
  expect(badge?.textContent).toContain("@scope/tool");
  expect(badge?.textContent).toContain("v1.2.3");
  expect(badge?.textContent).not.toContain("vv1.2.3");
  expect(badge?.textContent).toContain("120 / week");
  expect([...root.querySelectorAll(".noema-package-script pre")].map((item) => item.textContent)).toEqual([
    "npm i @scope/tool\n", "pnpm add @scope/tool\n", "deno add npm:@scope/tool\n",
  ]);
});

test("quoted shell arguments remain literal when they resemble document annotations", () => {
  const shell = "npm run check -- '{==keep==}{>>#c-abcd<<}'\n";
  const source = `#+begin npm-to {tabs=pnpm}\n~~~sh\n${shell}~~~\n#+end npm-to`;
  const root = document.createElement("div");
  root.innerHTML = renderMarkdownHTML(source);
  expect(root.querySelector(".noema-package-panel pre")?.textContent).toBe("pnpm run check '{==keep==}{>>#c-abcd<<}'\n");
});

test("a package tab mounts and copies only the active command", async () => {
  const source = '#+begin npm-badge {name=@scope/tool version=1.2.3}\n#+end npm-badge\n\n'
    + '#+begin npm-to Shell {tabs="npm,pnpm,deno"}\n~~~sh\nnpm i @scope/tool\n~~~\n#+end npm-to\n\nAfter.';
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent: source });
  let copied = "";
  setSystemClipboardWriter(async (text) => { copied = text; return true; });
  try {
    editor.setMarkdownSelection(source.length);
    await Promise.resolve();
    expect(host.querySelector(".noema-package-badge")?.textContent).toContain("@scope/tool");
    expect(host.querySelectorAll(".noema-package-panel pre")).toHaveLength(1);
    host.querySelector<HTMLButtonElement>(".noema-tab-button[title='deno']")!.click();
    host.querySelector<HTMLButtonElement>("[data-copy-package-command]")!.click();
    expect(copied).toBe("deno add npm:@scope/tool\n");
    editor.view.dispatch({changes: { from: 0, insert: "Before.\n\n" }});
    await Promise.resolve();
    expect(host.querySelector(".noema-package-panel")?.getAttribute("data-manager")).toBe("deno");
    expect(editor.getMarkdown()).toBe("Before.\n\n" + source);
    const start = editor.getMarkdown().indexOf("npm,pnpm,deno");
    editor.view.dispatch({changes: { from: start, to: start + "npm,pnpm,deno".length, insert: "deno,npm,pnpm" }});
    await Promise.resolve();
    expect(host.querySelector(".noema-package-panel")?.getAttribute("data-manager")).toBe("deno");
  } finally {
    setSystemClipboardWriter(null);
    editor.destroy();
    host.remove();
  }
});
