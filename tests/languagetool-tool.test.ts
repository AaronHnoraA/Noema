import { afterEach, describe, expect, test, vi } from "@voidzero-dev/vite-plus-test";

import { openLanguageToolSettingsTool } from "../aaronnote/languagetool-tool.ts";
import type { LanguageToolSettings } from "../aaronnote/api-client.ts";

const defaults: LanguageToolSettings = {
  automaticEnabled: true,
  serverUrl: "http://10.243.90.222:8765",
  language: "en-US",
  level: "picky",
  performanceProfile: "balanced",
  manualLocalFallback: true,
  remoteTimeoutMs: 5_000,
  retryCooldownMs: 30_000,
};

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("LanguageTool settings tool", () => {
  test("tests the draft server and saves normalized controls", async () => {
    const modal = document.createElement("div");
    modal.hidden = true;
    document.body.appendChild(modal);
    const updateSettings = vi.fn(async (settings: Partial<LanguageToolSettings>) => ({
      ok: true,
      settings: { ...defaults, ...settings },
      defaults,
      revision: "rev-2",
    }));
    const probe = vi.fn(async () => ({
      ok: true,
      latencyMs: 24,
      serverUrl: defaults.serverUrl,
      version: "6.8",
    }));
    const resultPromise = openLanguageToolSettingsTool({
      modal,
      api: { updateSettings, probe },
      settings: defaults,
      defaults,
      revision: "rev-1",
    });

    const server = modal.querySelector<HTMLInputElement>('input[type="url"]')!;
    const language = modal.querySelector<HTMLInputElement>('input[list="aaronnote-languagetool-languages"]')!;
    server.value = "https://lt.example.test";
    language.value = "en-AU";
    modal.querySelector<HTMLButtonElement>("button")!.click();
    await flushAsync();

    expect(probe).toHaveBeenCalledWith(expect.objectContaining({
      serverUrl: "https://lt.example.test",
      language: "en-AU",
    }));
    expect(modal.querySelector(".aaronnote-languagetool-health")?.textContent)
      .toContain("Online · 24 ms · 6.8");

    modal.querySelector<HTMLInputElement>('input[name="languagetool-profile"][value="quiet"]')!.checked = true;
    modal.querySelector<HTMLFormElement>("form")!.dispatchEvent(new Event("submit", {
      bubbles: true,
      cancelable: true,
    }));
    const result = await resultPromise;

    expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({
      serverUrl: "https://lt.example.test",
      language: "en-AU",
      performanceProfile: "quiet",
      manualLocalFallback: true,
      revision: "rev-1",
    }));
    expect(result).toMatchObject({
      revision: "rev-2",
      settings: { serverUrl: "https://lt.example.test", language: "en-AU" },
    });
    expect(modal.hidden).toBe(true);
  });

  test("remains cancellable while a server probe is pending", async () => {
    let resolveProbe!: (value: { ok: true; latencyMs: number }) => void;
    const pendingProbe = new Promise<{ ok: true; latencyMs: number }>((resolve) => {
      resolveProbe = resolve;
    });
    const modal = document.createElement("div");
    document.body.appendChild(modal);
    const cancelKeepalive = vi.fn();
    const resultPromise = openLanguageToolSettingsTool({
      modal,
      api: {
        updateSettings: vi.fn(),
        probe: vi.fn(() => pendingProbe),
        cancelKeepalive,
      },
      settings: defaults,
      defaults,
    });

    const buttons = [...modal.querySelectorAll<HTMLButtonElement>("button")];
    buttons.find((button) => button.textContent === "Test server")!.click();
    expect(modal.querySelector<HTMLInputElement>('input[type="url"]')!.disabled).toBe(true);
    expect(buttons.find((button) => button.textContent === "Cancel")!.disabled).toBe(false);
    buttons.find((button) => button.textContent === "Cancel")!.click();

    expect(await resultPromise).toBeNull();
    expect(cancelKeepalive).toHaveBeenCalledWith(expect.stringMatching(/.+/));
    resolveProbe({ ok: true, latencyMs: 10 });
    await flushAsync();
    expect(modal.childElementCount).toBe(0);
  });

  test("preserves a valid custom timeout when saved unchanged", async () => {
    const settings = { ...defaults, remoteTimeoutMs: 7_500 };
    const modal = document.createElement("div");
    document.body.appendChild(modal);
    const updateSettings = vi.fn(async () => ({ ok: true, settings, revision: "next" }));
    const resultPromise = openLanguageToolSettingsTool({
      modal,
      api: { updateSettings, probe: vi.fn() },
      settings,
      defaults,
      revision: "current",
    });

    modal.querySelector<HTMLFormElement>("form")!.dispatchEvent(new Event("submit", {
      bubbles: true,
      cancelable: true,
    }));
    await resultPromise;

    expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({
      remoteTimeoutMs: 7_500,
      revision: "current",
    }));
  });

  test("cannot report cancellation after a settings save has started", async () => {
    let resolveSave!: (value: { ok: true; settings: LanguageToolSettings; revision: string }) => void;
    const save = new Promise<{ ok: true; settings: LanguageToolSettings; revision: string }>((resolve) => {
      resolveSave = resolve;
    });
    const modal = document.createElement("div");
    document.body.appendChild(modal);
    const resultPromise = openLanguageToolSettingsTool({
      modal,
      api: { updateSettings: vi.fn(() => save), probe: vi.fn() },
      settings: defaults,
      defaults,
      revision: "current",
    });

    modal.querySelector<HTMLFormElement>("form")!.dispatchEvent(new Event("submit", {
      bubbles: true,
      cancelable: true,
    }));
    const cancel = [...modal.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Cancel")!;
    expect(cancel.disabled).toBe(true);
    modal.querySelector("form")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(modal.hidden).toBe(false);

    resolveSave({ ok: true, settings: defaults, revision: "next" });
    expect(await resultPromise).toMatchObject({ revision: "next", settings: defaults });
  });
});
