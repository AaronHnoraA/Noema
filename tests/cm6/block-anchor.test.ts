import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

const BLOCK_ID = "0198fc34-7b32-7a11-8cb4-6c40e3b33d68";

async function mount(text: string) {
  const { createEditorCM6 } = await import("../../src/cm6/editor-cm6.ts");
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditorCM6(host, { initialContent: text });
  return { editor, cleanup: () => { editor.destroy(); host.remove(); } };
}

describe("Noema block anchor badge", () => {
  test("Visual mode replaces a trailing UUIDv7 anchor with a badge", async () => {
    const text = `Paragraph text {#${BLOCK_ID}}`;
    const { editor, cleanup } = await mount(text);
    editor.setSelection(0, 0);
    const badge = document.querySelector<HTMLElement>(".cm-noema-block-id");
    expect(badge?.textContent).toBe("#…b33d68");
    expect(badge?.title).toBe(BLOCK_ID);
    expect(editor.view.dom.textContent).not.toContain("{#");
    cleanup();
  });

  test("the badge owns the complete portable property anchor", async () => {
    const text = `Claim {#${BLOCK_ID} status=draft owner="Aaron He"}`;
    const { editor, cleanup } = await mount(text);
    editor.setSelection(0, 0);
    expect(document.querySelector<HTMLElement>(".cm-noema-block-id")?.title).toBe(BLOCK_ID);
    expect(editor.view.dom.textContent).toContain("Claim");
    expect(editor.view.dom.textContent).not.toContain("status=draft");
    const propertyPosition = text.indexOf("status");
    editor.setSelection(propertyPosition, propertyPosition);
    expect(document.querySelector(".cm-noema-block-id")).toBeNull();
    expect(editor.view.dom.textContent).toContain("owner=\"Aaron He\"");
    cleanup();
  });

  test("clicking copies the canonical full ID", async () => {
    const text = `Paragraph text {#${BLOCK_ID}}`;
    const { editor, cleanup } = await mount(text);
    editor.setSelection(0, 0);
    let copied = "";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (value: string) => { copied = value; } },
    });
    document.querySelector<HTMLElement>(".cm-noema-block-id")?.click();
    await Promise.resolve();
    expect(copied).toBe(BLOCK_ID);
    cleanup();
  });

  test("touching the anchor reveals the raw source", async () => {
    const text = `Paragraph text {#${BLOCK_ID}}`;
    const { editor, cleanup } = await mount(text);
    editor.setSelection(0, 0);
    expect(document.querySelector(".cm-noema-block-id")).toBeTruthy();
    editor.setSelection(text.indexOf("{#") + 2, text.indexOf("{#") + 2);
    expect(document.querySelector(".cm-noema-block-id")).toBeNull();
    expect(editor.view.dom.textContent).toContain(`{#${BLOCK_ID}}`);
    cleanup();
  });

  test("Source mode leaves the anchor literal", async () => {
    const { toggleAaronnoteMarkdownSource } = await import("../../src/cm6/editor-cm6.ts");
    const text = `Paragraph text {#${BLOCK_ID}}`;
    const { editor, cleanup } = await mount(text);
    toggleAaronnoteMarkdownSource(editor.view);
    expect(document.querySelector(".cm-noema-block-id")).toBeNull();
    expect(editor.view.dom.textContent).toContain(`{#${BLOCK_ID}}`);
    cleanup();
  });

  test("org-env identities remain owned by block-extras", async () => {
    const { editor, cleanup } = await mount(`#+begin note Title {#${BLOCK_ID}}\nbody\n#+end note`);
    expect(document.querySelector(".cm-noema-block-id")).toBeNull();
    void editor;
    cleanup();
  });

  test("code blocks and unrelated trailing attrs are not decorated", async () => {
    const { editor, cleanup } = await mount(`![alt](a.png){width: 200px}\n\n\`\`\`\n{#${BLOCK_ID}}\n\`\`\``);
    expect(document.querySelector(".cm-noema-block-id")).toBeNull();
    void editor;
    cleanup();
  });
});
