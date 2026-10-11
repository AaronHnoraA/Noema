// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from "@voidzero-dev/vite-plus-test";
import { createReferencePicker, drillQuery, renderMatchedLabel, type ReferenceAnswer, type ReferenceItem } from "../aaronnote/reference-picker.ts";

const heading: ReferenceItem = {
  kind: "heading", label: "Lease expiry", group: "This page", level: 2, detail: "##",
  insert: "[Lease expiry](roam://id-1@setup@lease-expiry)", target: "roam://id-1@setup@lease-expiry",
};
const page: ReferenceItem = {
  kind: "page", label: "Tensor Isomorphism", title: "Tensor Isomorphism", group: "Pages",
  pageId: "id-3", insert: "[Tensor Isomorphism](roam://id-3)", target: "roam://id-3",
  detail: "CS · Complexity/tensor_isomorphism.md", titleRanges: [[0, 3]], labelRange: [1, 19],
};

const settle = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(100);
  await Promise.resolve();
};

function mount(answers: Record<string, ReferenceAnswer>) {
  const asked: string[] = [];
  const inserted: Array<{ item: ReferenceItem; context: unknown }> = [];
  const closed = vi.fn();
  const picker = createReferencePicker({
    lookup: async (query) => {
      asked.push(query);
      return answers[query] || { ok: true, items: [] };
    },
    insert: (item, context) => inserted.push({ item, context }),
    anchor: () => ({ left: 40, top: 100, bottom: 118 }),
    closed,
  });
  const root = document.querySelector<HTMLElement>(".noema-reference-picker")!;
  const input = root.querySelector("input")!;
  const press = (key: string, init: KeyboardEventInit = {}): void => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  };
  const type = (value: string): void => {
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const rows = (): string[] => [...root.querySelectorAll("[role='option']")].map((row) => `${row.getAttribute("aria-selected") === "true" ? ">" : " "}${row.querySelector("strong")!.textContent}`);
  return { picker, root, input, press, type, rows, asked, inserted, closed };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("reference picker", () => {
  test("shows the kernel's answer in its groups and inserts the text the kernel wrote", async () => {
    vi.useFakeTimers();
    const ui = mount({
      "": { ok: true, items: [heading, page], explain: [] },
      ten: { ok: true, items: [page], explain: ["headings and tags of this page, then pages"] },
    });
    ui.picker.open();
    await settle();
    expect(ui.root.hidden).toBe(false);
    expect(document.activeElement).toBe(ui.input);
    expect(ui.rows()).toEqual([">Lease expiry", " Tensor Isomorphism"]);
    expect([...ui.root.querySelectorAll("h4")].map((node) => node.textContent)).toEqual(["This page", "Pages"]);

    ui.type("ten");
    await settle();
    expect(ui.asked).toEqual(["", "ten"]);
    expect(ui.rows()).toEqual([">Tensor Isomorphism"]);
    // The kernel's ranges are what is highlighted; the page matches nothing itself.
    expect(ui.root.querySelector("mark")!.textContent).toBe("Ten");
    expect(ui.root.querySelector(".noema-reference-picker-hint")!.textContent).toBe("headings and tags of this page, then pages");

    ui.press("Enter");
    // The whole item is handed over: its text, its bare target and where its
    // label sits, so the editor can replace typed text and select the label.
    expect(ui.inserted).toEqual([{ item: page, context: undefined }]);
    expect(ui.inserted[0]!.item.labelRange).toEqual([1, 19]);
    expect(ui.root.hidden).toBe(true);
    expect(ui.closed).toHaveBeenCalledTimes(1);
    expect(ui.closed).toHaveBeenCalledWith(true, undefined);
  });

  test("arrows move, Tab looks inside a page, Escape closes without inserting", async () => {
    vi.useFakeTimers();
    const inside: ReferenceItem = { kind: "heading", label: "Reductions", group: "CS:Tensor Isomorphism", insert: "[Reductions](roam://id-3@reductions)" };
    const ui = mount({
      "": { ok: true, items: [heading, page] },
      "id-3@": { ok: true, items: [inside] },
    });
    ui.picker.open();
    await settle();
    ui.press("Tab");
    await settle();
    // A heading has nothing inside it.
    expect(ui.input.value).toBe("");
    ui.press("ArrowDown");
    expect(ui.rows()).toEqual([" Lease expiry", ">Tensor Isomorphism"]);
    ui.press("ArrowDown");
    expect(ui.rows()[1]).toBe(">Tensor Isomorphism");
    ui.press("p", { ctrlKey: true });
    ui.press("n", { ctrlKey: true });
    ui.press("Tab");
    await settle();
    // The page is named by its id, and "@" asks for its headings.
    expect(ui.input.value).toBe("id-3@");
    expect(ui.rows()).toEqual([">Reductions"]);
    ui.press("Escape");
    expect(ui.root.hidden).toBe(true);
    expect(ui.inserted).toEqual([]);
    expect(ui.picker.isOpen()).toBe(false);
    expect(ui.closed).toHaveBeenLastCalledWith(false, undefined);

    // Opened by a link typed in the note, it hands that context back.
    const typed = { mode: "target", start: 12, before: 7, after: 0 };
    ui.picker.open("roam://", typed);
    await settle();
    expect(ui.asked.at(-1)).toBe("roam://");
    ui.press("Escape");
    expect(ui.closed).toHaveBeenLastCalledWith(false, typed);
  });

  test("a late answer to an earlier input is dropped, and a failing kernel says so", async () => {
    vi.useFakeTimers();
    let release: (answer: ReferenceAnswer) => void = () => {};
    const inserted: string[] = [];
    const picker = createReferencePicker({
      lookup: (query) => query === "slow"
        ? new Promise<ReferenceAnswer>((resolve) => { release = resolve; })
        : query === "boom" ? Promise.reject(new Error("down")) : Promise.resolve({ ok: true, items: [page] }),
      insert: (item) => inserted.push(item.insert),
      anchor: () => null,
    });
    const root = document.querySelector<HTMLElement>(".noema-reference-picker")!;
    const input = root.querySelector("input")!;
    const type = (value: string): void => { input.value = value; input.dispatchEvent(new Event("input", { bubbles: true })); };
    picker.open("slow");
    await settle();
    type("fast");
    await settle();
    release({ ok: true, items: [heading] });
    await settle();
    expect(root.querySelector("strong")!.textContent).toBe("Tensor Isomorphism");
    type("boom");
    await settle();
    expect(root.querySelector(".noema-reference-picker-list p")!.textContent).toBe("Noema's kernel is not answering.");
    picker.destroy();
    expect(document.querySelector(".noema-reference-picker")).toBeNull();
  });

  test("helpers", () => {
    expect(drillQuery(page)).toBe("id-3@");
    expect(drillQuery({ kind: "page", label: "Draft", title: "Draft", insert: "[[Draft]]" })).toBe("Draft@");
    expect(drillQuery(heading)).toBeNull();
    const host = document.createElement("div");
    host.append(renderMatchedLabel("线性码等价", [[0, 2], [9, 12], [3, 3]]));
    expect(host.innerHTML).toBe("<mark>线性</mark>码等价");
  });
});
