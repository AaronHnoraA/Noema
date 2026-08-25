/**
 * Block-reference live-preview (src/cm6/extensions/visual/widgets/block-ref.ts).
 *
 * Noema's canonical form uses UUIDv7 block identities. The timestamp-shaped
 * IDs emitted during the SiYuan-kernel spike remain readable compatibility.
 * These tests pin: the
 * widget replaces both forms with a link-styled chip, the click handler
 * dispatches a bubbling `aaronnote:open-block-ref` CustomEvent instead of
 * doing any navigation itself, cursor-touch reveals raw source (same
 * contract as footnotes.ts / kramdown-ial.ts), and a plain non-ID
 * `((...))` parenthetical is left alone.
 */

import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

async function mount(text: string) {
  const { createEditorCM6 } = await import("../../src/cm6/editor-cm6.ts");
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditorCM6(host, { initialContent: text });
  return {
    editor,
    cleanup: () => { editor.destroy(); host.remove(); },
  };
}

describe("block reference live-preview", () => {
  const blockId = "0198fc34-7b32-7a11-8cb4-6c40e3b33d68";

  test("a ref with anchor text renders the text as a link-styled chip", async () => {
    const text = `See ((${blockId} "loadDoc bullet")) for details.`;
    const { editor, cleanup } = await mount(text);
    editor.setSelection(text.length, text.length); // cursor away from the ref
    const chip = document.querySelector<HTMLElement>(".cm-block-ref");
    expect(chip?.textContent).toBe("loadDoc bullet");
    expect(chip?.title).toBe(blockId);
    expect(editor.view.dom.textContent).not.toContain("((");
    cleanup();
  });

  test("a bare anchor-only ref falls back to a short ID badge", async () => {
    const text = `And anchor-only: ((${blockId})).`;
    const { editor, cleanup } = await mount(text);
    editor.setSelection(text.length, text.length);
    const chip = document.querySelector<HTMLElement>(".cm-block-ref");
    expect(chip?.textContent).toBe("#…b33d68");
    cleanup();
  });

  test("clicking the chip dispatches a bubbling, cancelable aaronnote:open-block-ref event", async () => {
    const text = `See ((${blockId} "loadDoc bullet")) for details.`;
    const { editor, cleanup } = await mount(text);
    editor.setSelection(text.length, text.length);
    const chip = document.querySelector<HTMLElement>(".cm-block-ref")!;
    let detail: unknown = null;
    editor.view.dom.addEventListener("aaronnote:open-block-ref", (event) => {
      detail = (event as CustomEvent).detail;
    });
    chip.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    chip.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(detail).toEqual({ id: blockId, text: "loadDoc bullet" });
    cleanup();
  });

  test("cursor inside the span reveals the raw source and hides the chip", async () => {
    const text = `See ((${blockId} "loadDoc bullet")) for details.`;
    const { editor, cleanup } = await mount(text);
    editor.setSelection(text.length, text.length);
    expect(document.querySelector(".cm-block-ref")).toBeTruthy();
    editor.setSelection(10, 10); // inside the ref span
    expect(document.querySelector(".cm-block-ref")).toBeNull();
    expect(editor.view.dom.textContent).toContain(`((${blockId} "loadDoc bullet"))`);
    cleanup();
  });

  test("a plain parenthetical that is not a Noema or legacy block ID is left as ordinary text", async () => {
    const { editor, cleanup } = await mount("This ((ordinary-block)), not a ref.");
    expect(document.querySelector(".cm-block-ref")).toBeNull();
    void editor;
    cleanup();
  });

  test("a fenced code block containing literal ref text is not turned into a chip", async () => {
    const { editor, cleanup } = await mount(
      `\`\`\`\n((${blockId} "loadDoc bullet"))\n\`\`\``,
    );
    expect(document.querySelector(".cm-block-ref")).toBeNull();
    void editor;
    cleanup();
  });

  test("legacy SiYuan timestamp IDs remain readable", async () => {
    const text = "Legacy ((20260825095344-i40x2sr)).";
    const { editor, cleanup } = await mount(text);
    editor.setSelection(0, 0);
    expect(document.querySelector<HTMLElement>(".cm-block-ref")?.title).toBe("20260825095344-i40x2sr");
    cleanup();
  });
});
