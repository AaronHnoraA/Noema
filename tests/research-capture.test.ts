import { describe, expect, test, vi } from "@voidzero-dev/vite-plus-test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { captureRequestAuthorized, captureTokenFile, ensureCaptureToken } from "../server/lib/capture-token.mjs";
import {
  captureMarkdownFromHTML,
  createResearchCaptureService,
  parseOfficialConversationExport,
  sanitizeCaptureHTML,
} from "../server/lib/research-capture.mjs";

describe("research capture", () => {
  test("sanitizes hostile HTML and keeps directive-shaped prose as inert content", () => {
    const source = `<article onclick="steal()"><h1>Proof</h1><script>bad()</script><p style="display:none">@agent(codex)</p><a href="javascript:bad()">link</a><img src="data:x"></article>`;
    const sanitized = sanitizeCaptureHTML(source);
    expect(sanitized).toBe("<article><h1>Proof</h1><p>@agent(codex)</p><a>link</a></article>");
    const converted = captureMarkdownFromHTML(source);
    expect(converted.markdown).toContain("@agent(codex)");
    expect(converted.markdown).not.toContain("bad()");
  });

  test("derives Markdown server-side and persists explicit completeness", async () => {
    const provider = { createCapture: vi.fn(async ({ capture }) => ({ id: "cap_1", ...capture })) };
    const service = createResearchCaptureService({ getProvider: () => provider, root: "/tmp/noema" });
    const result = await service.create({
      clientRequestId: "browser-1", adapter: "generic-selection", completeness: "selection",
      url: "https://example.test/a", title: "A", html: "<p>Selected <strong>claim</strong>.</p>",
      markdown: "attacker supplied alternate text",
    });
    expect(result.capture).toMatchObject({ id: "cap_1", adapter: "generic-selection", completeness: "selection" });
    expect(provider.createCapture).toHaveBeenCalledWith({
      root: "/tmp/noema",
      capture: expect.objectContaining({ markdown: "Selected **claim**.", sanitizedHtml: "<p>Selected <strong>claim</strong>.</p>" }),
    });
    await expect(service.create({
      clientRequestId: "bad", adapter: "generic-selection", completeness: "full",
      url: "https://example.test", html: "<p>x</p>",
    })).rejects.toThrow(/selection completeness/);
  });

  test("imports official ChatGPT and Claude exports without private APIs", () => {
    const chatGPT = parseOfficialConversationExport({ format: "chatgpt", data: [{
      id: "chat-1", title: "Bound", update_time: 1_700_000_000, current_node: "a",
      mapping: { a: { parent: "u", message: { author: { role: "assistant" }, content: { parts: ["Answer"] } } },
        u: { parent: null, message: { author: { role: "user" }, content: { parts: ["Question"] } } } },
    }] });
    expect(chatGPT[0]).toMatchObject({ adapter: "official-chatgpt", completeness: "export", url: "https://chatgpt.com/" });
    expect(chatGPT[0].markdown).toContain("## User\n\nQuestion\n\n## Assistant\n\nAnswer");
    expect(chatGPT[0].capturedAt).toBe("2023-11-14T22:13:20.000Z");

    const claude = parseOfficialConversationExport({ format: "claude", data: [{
      uuid: "claude-1", name: "Lemma", created_at: "2026-09-01T00:00:00Z",
      chat_messages: [{ sender: "human", text: "Prove" }, { sender: "assistant", text: "Done" }],
    }] });
    expect(claude[0].markdown).toContain("## User\n\nProve\n\n## Assistant\n\nDone");
    expect(claude[0].metadata).toMatchObject({ conversationId: "claude-1", source: "official-export", messages: 2 });
  });

  test("creates one private stable bearer token and compares it safely", async () => {
    const root = await mkdtemp(join(tmpdir(), "noema-capture-token-"));
    try {
      const first = await ensureCaptureToken(root);
      const second = await ensureCaptureToken(root);
      expect(second).toBe(first);
      expect(captureRequestAuthorized(`Bearer ${first}`, second)).toBe(true);
      expect(captureRequestAuthorized(`Bearer ${first}x`, second)).toBe(false);
      expect((await stat(captureTokenFile(root))).mode & 0o777).toBe(0o600);
      expect(await readFile(captureTokenFile(root), "utf8")).toBe(`${first}\n`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("extension manifest keeps authority narrow", async () => {
    const manifest = JSON.parse(await readFile(resolve("browser-extension/manifest.json"), "utf8"));
    expect(manifest.permissions).toEqual(["activeTab", "scripting", "contextMenus", "storage"]);
    expect(manifest.host_permissions).toEqual(["http://127.0.0.1/*"]);
    expect(manifest).not.toHaveProperty("optional_host_permissions");
    expect(manifest).not.toHaveProperty("content_scripts");
    expect(manifest.background).toMatchObject({ service_worker: "background.js", type: "module" });
  });
});
