import { expect, test, vi } from "@voidzero-dev/vite-plus-test";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEditor } from "../src/editor-api.ts";
import { renderMarkdownHTML } from "../src/render-html.ts";
// @ts-ignore Host runtime uses the independent Node module graph.
import { configure } from "../server/lib/state.mjs";
// @ts-ignore Host runtime uses the independent Node module graph.
import { documentRunContext } from "../server/lib/runtime.mjs";

test("document runs require a saved note and a working directory within its content root", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "noema-document-run-"));
  try {
    const root = join(scratch, "project");
    const cwd = join(root, "src");
    const note = join(root, "document.md");
    await mkdir(cwd, {recursive:true});
    await writeFile(note, "# Fixture\n");
    await symlink(scratch, join(root, "outside"));
    configure({root, workspaceRoot:root, pluginRoot:join(scratch, "plugin")});
    expect(await documentRunContext(note, "src")).toEqual({note:await realpath(note), directory:await realpath(cwd)});
    expect(await documentRunContext(note)).toEqual({note:await realpath(note)});
    await expect(documentRunContext(note, "outside")).rejects.toMatchObject({statusCode:403});
    await expect(documentRunContext(note, "document.md")).rejects.toMatchObject({statusCode:400});
    await expect(documentRunContext("", ".")).rejects.toMatchObject({statusCode:400});
  } finally {
    await rm(scratch, {recursive:true, force:true});
  }
});

test("reopening a tab resumes the pending native run without another start", async () => {
  const previousApi = window.noemaApi;
  const previousFile = window.NoemaCurrentFile;
  let acknowledge!: (snapshot: unknown) => void;
  const pending = new Promise((resolve) => { acknowledge = resolve; });
  const request = vi.fn((body: unknown) => (body as { action: string }).action === "start" ? pending
    : Promise.resolve({ok:true,id:"pending",status:"succeeded",output:"fixture output",hasOutput:true,stopRequested:false}));
  vi.stubGlobal("IntersectionObserver", undefined);
  window.noemaApi = {documentAssets:{run:request}};
  window.NoemaCurrentFile = () => "/fixture/tabs.md";
  const host = document.createElement("div");
  document.body.append(host);
  const source = "#+begin tabs\n\n## Run\n\n#+begin run {cmd=echo}\n#+end run\n\n## Read\n\nText.\n#+end tabs\n\nAfter.";
  const editor = createEditor(host, {initialContent:source});
  try {
    editor.setMarkdownSelection(source.length);
    const tab = (title: string) => Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
      .find((button) => button.textContent === title)!;
    await vi.waitFor(() => expect(host.querySelector("[data-run-start]")).not.toBeNull());
    const first = host.querySelector<HTMLButtonElement>("[data-run-start]")!;
    first.click();
    tab("Read").click();
    await vi.waitFor(() => expect(first.isConnected).toBe(false));
    acknowledge({ok:true,id:"pending",status:"awaiting",hasOutput:false,stopRequested:false});
    await Promise.resolve();
    tab("Run").click();
    await vi.waitFor(() => expect(host.querySelector(".noema-run-output")?.textContent).toBe("fixture output"));
    expect(request.mock.calls.map(([body]) => (body as {action:string}).action)).toEqual(["start","status"]);
  } finally {
    editor.destroy();
    host.remove();
    window.noemaApi = previousApi;
    window.NoemaCurrentFile = previousFile;
    vi.unstubAllGlobals();
  }
});

test("document execution begins on explicit activation and publishes just its command and body", async () => {
  const previousApi = window.noemaApi;
  const previousFile = window.NoemaCurrentFile;
  const notePath = "/fixture/actions.md";
  const command = "printf 'fixture'";
  let polls = 0;
  const request = vi.fn(async (body: unknown) => {
    const { action } = body as { action: string };
    if (action === "status" && ++polls === 1) throw new Error("Temporary bridge failure");
    return action === "start" ? {ok:true,id:"case-a",status:"awaiting",hasOutput:false,stopRequested:false}
      : {ok:true,id:"case-a",status:"succeeded",exitCode:0,output:"live-only fixture result",hasOutput:true,stopRequested:false};
  });
  vi.stubGlobal("IntersectionObserver", undefined);
  window.noemaApi = {documentAssets:{run:request}};
  window.NoemaCurrentFile = () => notePath;
  const host = document.createElement("div");
  document.body.append(host);
  const source = "#+begin run Check {cwd=src}\n```sh\n" + command + "\n```\nPublic explanation.\n#+end run\n\nAfter.";
  const editor = createEditor(host, {initialContent:source});
  try {
    editor.setMarkdownSelection(source.length);
    await new Promise((resolve) => setTimeout(resolve,0));
    expect(request).not.toHaveBeenCalled();
    const widget = host.querySelector<HTMLElement>(".noema-document-run")!;
    expect(widget.dataset.runCommand).toBe(command);
    widget.querySelector<HTMLButtonElement>("[data-run-start]")!.click();
    expect(request).toHaveBeenCalledWith({notePath, action:"start", command, cwd:"src"});
    await vi.waitFor(() => expect(widget.querySelector(".noema-run-status")?.textContent).toContain("Reconnecting"));
    expect(widget.querySelector<HTMLButtonElement>("[data-run-start]")?.disabled).toBe(true);
    await vi.waitFor(() => expect(widget.querySelector(".noema-run-output")?.textContent).toBe("live-only fixture result"), {timeout:2000});
    expect(polls).toBe(2);
    widget.querySelector<HTMLButtonElement>("[data-run-open]")!.click();
    expect(request).toHaveBeenCalledWith({notePath, action:"open", id:"case-a"});
    const printed = renderMarkdownHTML(source);
    expect(printed).toContain("printf");
    expect(printed).toContain("Public explanation.");
    expect(printed).not.toMatch(/data-run-start|live-only fixture result/);
    expect(editor.getMarkdown()).toBe(source);
  } finally {
    editor.destroy();
    host.remove();
    window.noemaApi = previousApi;
    window.NoemaCurrentFile = previousFile;
    vi.unstubAllGlobals();
  }
});
