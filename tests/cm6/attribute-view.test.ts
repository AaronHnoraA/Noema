import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

async function mount(text: string) {
  const { createEditorCM6 } = await import("../../src/cm6/editor-cm6.ts");
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditorCM6(host, { initialContent: text });
  return { editor, cleanup: () => { editor.destroy(); host.remove(); } };
}

describe("portable attribute-view widget", () => {
  const source = [
    "Before", "",
    "#+begin av Open work",
    "source: todo",
    "columns: text, status, project",
    "filter: status in todo|doing",
    "#+end av",
    "",
    "After",
  ].join("\n");

  test("requests a host model and renders its table without changing Markdown", async () => {
    const { editor, cleanup } = await mount(source);
    editor.setSelection(source.length, source.length);
    let request: any = null;
    editor.view.dom.addEventListener("aaronnote:attribute-view-request", (event) => {
      event.preventDefault();
      request = (event as CustomEvent).detail;
      request.respond({
        title: "Open work", source: "todo",
        columns: [{ key: "text", label: "Task" }, { key: "status", label: "Status" }, { key: "project", label: "Project" }],
        rows: [{ id: "#a", kind: "todo", file: "/paper.md", index: 20, line: 3, cells: [{ key: "text", value: "Draft" }, { key: "status", value: "doing" }, { key: "project", value: "paper" }] }],
        total: 1, truncated: false, diagnostics: [], evaluationSource: "kernel-attribute-view",
      });
    });
    editor.view.dom.querySelector<HTMLButtonElement>(".cm-attribute-view-action")?.click();
    await Promise.resolve();
    expect(request).toMatchObject({ title: "Open work", source: expect.stringContaining("columns: text, status, project") });
    expect(editor.view.dom.querySelector<HTMLElement>(".cm-attribute-view-title")?.textContent).toBe("Open work");
    expect(Array.from(editor.view.dom.querySelectorAll(".cm-attribute-view-table th")).map((node) => node.textContent)).toEqual(["Task", "Status", "Project"]);
    expect(Array.from(editor.view.dom.querySelectorAll(".cm-attribute-view-table td")).map((node) => node.textContent)).toEqual(["Draft", "doing", "paper"]);
    expect(editor.view.dom.querySelector<HTMLElement>(".cm-attribute-view")?.dataset.evaluationSource).toBe("kernel-attribute-view");
    expect(editor.getMarkdown()).toBe(source);
    cleanup();
  });

  test("moving the cursor into the AV reveals the portable source", async () => {
    const { editor, cleanup } = await mount(source);
    editor.setSelection(source.length, source.length);
    expect(editor.view.dom.querySelector(".cm-attribute-view")).toBeTruthy();
    const inside = source.indexOf("columns:") + 2;
    editor.setSelection(inside, inside);
    expect(editor.view.dom.querySelector(".cm-attribute-view")).toBeNull();
    expect(editor.view.dom.textContent).toContain("columns: text, status, project");
    cleanup();
  });

  test("double-clicking an editable cell emits a stable row patch request", async () => {
    const { editor, cleanup } = await mount(source);
    editor.setSelection(source.length, source.length);
    editor.view.dom.addEventListener("aaronnote:attribute-view-request", (event) => {
      event.preventDefault();
      (event as CustomEvent).detail.respond({
        title: "Open work", source: "todo",
        columns: [{ key: "text", label: "Task" }, { key: "status", label: "Status" }],
        rows: [{ id: "#a", kind: "todo", file: "/paper.md", index: 20, line: 3, cells: [{ key: "text", value: "Draft" }, { key: "status", value: "doing" }] }],
        total: 1, truncated: false, diagnostics: [],
      });
    });
    editor.view.dom.querySelector<HTMLButtonElement>(".cm-attribute-view-action")?.click();
    await Promise.resolve();
    let patch: any = null;
    editor.view.dom.addEventListener("aaronnote:attribute-view-cell-patch", (event) => {
      event.preventDefault();
      patch = (event as CustomEvent).detail;
      patch.respond(false, "fixture stops before mutation");
    });
    let opened: any = null;
    editor.view.dom.addEventListener("aaronnote:attribute-view-open-row", (event) => {
      event.preventDefault();
      opened = (event as CustomEvent).detail;
    });
    editor.view.dom.querySelector<HTMLTableCellElement>('td[data-column="text"]')
      ?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(opened).toMatchObject({ row: { file: "/paper.md", index: 20, line: 3 } });
    const statusCell = editor.view.dom.querySelector<HTMLTableCellElement>('td[data-column="status"]')!;
    statusCell.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const select = statusCell.querySelector<HTMLSelectElement>("select")!;
    select.value = "done";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(patch).toMatchObject({ row: { id: "#a", kind: "todo", file: "/paper.md", index: 20 }, key: "status", value: "done" });
    expect(statusCell.title).toContain("fixture stops before mutation");
    cleanup();
  });

  test("edits arbitrary property columns but keeps block identity fields read-only", async () => {
    const { editor, cleanup } = await mount(source);
    editor.setSelection(source.length, source.length);
    editor.view.dom.addEventListener("aaronnote:attribute-view-request", (event) => {
      event.preventDefault();
      (event as CustomEvent).detail.respond({
        title: "Claims", source: "block",
        columns: [{ key: "text", label: "Text" }, { key: "id", label: "ID" }, { key: "owner", label: "Owner" }],
        rows: [{
          id: "#0198fc34-7b32-7a11-8cb4-6c40e3b33d68", kind: "prose", file: "/paper.md", index: 20, line: 3,
          cells: [{ key: "text", value: "Claim" }, { key: "id", value: "#0198fc34-7b32-7a11-8cb4-6c40e3b33d68" }, { key: "owner", value: "Aaron" }],
        }],
        total: 1, truncated: false, diagnostics: [],
      });
    });
    editor.view.dom.querySelector<HTMLButtonElement>(".cm-attribute-view-action")?.click();
    await Promise.resolve();
    expect(editor.view.dom.querySelector('td[data-column="id"]')?.classList.contains("cm-attribute-view-cell-editable")).toBe(false);
    let patch: any = null;
    editor.view.dom.addEventListener("aaronnote:attribute-view-cell-patch", (event) => {
      event.preventDefault();
      patch = (event as CustomEvent).detail;
      patch.respond(false, "fixture stops before mutation");
    });
    const owner = editor.view.dom.querySelector<HTMLTableCellElement>('td[data-column="owner"]')!;
    owner.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const input = owner.querySelector<HTMLInputElement>("input")!;
    input.value = "Noema Team";
    input.dispatchEvent(new FocusEvent("blur"));
    expect(patch).toMatchObject({
      row: { id: "#0198fc34-7b32-7a11-8cb4-6c40e3b33d68", kind: "prose", file: "/paper.md" },
      key: "owner", value: "Noema Team",
    });
    cleanup();
  });

  test("renders gallery cards with the same stable open and property-patch events", async () => {
    const { editor, cleanup } = await mount(source);
    editor.setSelection(source.length, source.length);
    editor.view.dom.addEventListener("aaronnote:attribute-view-request", (event) => {
      event.preventDefault();
      (event as CustomEvent).detail.respond({
        title: "Claims", source: "block", view: "gallery",
        columns: [{ key: "text", label: "Text" }, { key: "owner", label: "Owner" }],
        rows: [{
          id: "#0198fc34-7b32-7a11-8cb4-6c40e3b33d68", kind: "prose", file: "/paper.md", index: 20, line: 3,
          cells: [{ key: "text", value: "Portable claim" }, { key: "owner", value: "Aaron" }],
        }],
        total: 1, truncated: false, diagnostics: [],
      });
    });
    editor.view.dom.querySelector<HTMLButtonElement>(".cm-attribute-view-action")?.click();
    await Promise.resolve();
    expect(editor.view.dom.querySelector<HTMLElement>(".cm-attribute-view")?.dataset.view).toBe("gallery");
    expect(editor.view.dom.querySelector(".cm-attribute-view-table")).toBeNull();
    expect(editor.view.dom.querySelector(".cm-attribute-view-card-title")?.textContent).toBe("Portable claim");
    let opened: any = null;
    editor.view.dom.addEventListener("aaronnote:attribute-view-open-row", (event) => {
      event.preventDefault();
      opened = (event as CustomEvent).detail;
    });
    editor.view.dom.querySelector<HTMLElement>('.cm-attribute-view-card [data-column="text"]')
      ?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(opened).toMatchObject({ row: { id: "#0198fc34-7b32-7a11-8cb4-6c40e3b33d68", file: "/paper.md", line: 3 } });
    let patch: any = null;
    editor.view.dom.addEventListener("aaronnote:attribute-view-cell-patch", (event) => {
      event.preventDefault();
      patch = (event as CustomEvent).detail;
      patch.respond(false, "fixture stops before mutation");
    });
    const owner = editor.view.dom.querySelector<HTMLElement>('.cm-attribute-view-card [data-column="owner"]')!;
    owner.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const input = owner.querySelector<HTMLInputElement>("input")!;
    input.value = "Noema Team";
    input.dispatchEvent(new FocusEvent("blur"));
    expect(patch).toMatchObject({ row: { kind: "prose", index: 20 }, key: "owner", value: "Noema Team" });
    cleanup();
  });

  test("renders kanban lanes and keeps visible grouping cells editable", async () => {
    const { editor, cleanup } = await mount(source);
    editor.setSelection(source.length, source.length);
    editor.view.dom.addEventListener("aaronnote:attribute-view-request", (event) => {
      event.preventDefault();
      (event as CustomEvent).detail.respond({
        title: "Work board", source: "todo", view: "kanban", groupBy: "status",
        columns: [{ key: "text", label: "Task" }, { key: "status", label: "Status" }, { key: "prio", label: "Priority" }],
        rows: [
          { id: "#a", kind: "todo", file: "/paper.md", index: 20, line: 3, group: "doing", cells: [{ key: "text", value: "Draft" }, { key: "status", value: "doing" }, { key: "prio", value: "A" }] },
          { id: "#b", kind: "todo", file: "/paper.md", index: 40, line: 4, group: "todo", cells: [{ key: "text", value: "Polish" }, { key: "status", value: "todo" }, { key: "prio", value: "B" }] },
        ],
        total: 2, truncated: false, diagnostics: [],
      });
    });
    editor.view.dom.querySelector<HTMLButtonElement>(".cm-attribute-view-action")?.click();
    await Promise.resolve();
    expect(editor.view.dom.querySelector<HTMLElement>(".cm-attribute-view")?.dataset.view).toBe("kanban");
    expect(editor.view.dom.querySelector<HTMLElement>(".cm-attribute-view-kanban")?.dataset.groupBy).toBe("status");
    expect(Array.from(editor.view.dom.querySelectorAll(".cm-attribute-view-kanban-lane")).map((lane) => lane.getAttribute("data-group"))).toEqual(["doing", "todo"]);
    expect(Array.from(editor.view.dom.querySelectorAll(".cm-attribute-view-kanban-header strong")).map((node) => node.textContent)).toEqual(["doing", "todo"]);
    let patch: any = null;
    editor.view.dom.addEventListener("aaronnote:attribute-view-cell-patch", (event) => {
      event.preventDefault();
      patch = (event as CustomEvent).detail;
      patch.respond(false, "fixture stops before mutation");
    });
    const status = editor.view.dom.querySelector<HTMLElement>('.cm-attribute-view-card[data-attribute-view-row-id="#a"] [data-column="status"]')!;
    status.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const select = status.querySelector<HTMLSelectElement>("select")!;
    select.value = "done";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(patch).toMatchObject({ row: { id: "#a", file: "/paper.md", index: 20 }, key: "status", value: "done" });
    cleanup();
  });

  test("an AV-looking block inside fenced code remains literal", async () => {
    const { editor, cleanup } = await mount("```\n#+begin av Nope\nsource: todo\n#+end av\n```");
    expect(editor.view.dom.querySelector(".cm-attribute-view")).toBeNull();
    void editor;
    cleanup();
  });
});
