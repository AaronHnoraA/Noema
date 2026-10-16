import { afterEach, describe, expect, test, vi } from "@voidzero-dev/vite-plus-test";
import {
  cancelExternalProseCheck,
  clearProseParagraphCache,
  languageToolCategory,
  parseLanguageToolDiagnostics,
  probeLanguageTool,
  runExternalProseChecks,
} from "../server/lib/prose-check.mjs";

afterEach(() => {
  vi.restoreAllMocks();
  clearProseParagraphCache();
});

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("prose check diagnostic mapping", () => {
  test("LanguageTool diagnostics preserve replacements and source offsets", () => {
    const source = "This are a bad sentence.";
    const output = JSON.stringify({
      matches: [{
        offset: 0,
        length: 8,
        message: "The verb 'are' is plural.",
        replacements: [{ value: "This is" }],
        rule: {
          id: "PLURAL_VERB_AFTER_THIS",
          issueType: "grammar",
          category: { id: "GRAMMAR" },
        },
      }],
    });
    expect(parseLanguageToolDiagnostics(output, source)).toEqual([expect.objectContaining({
      from: 0,
      to: 8,
      word: "This are",
      suggestions: ["This is"],
    })]);
  });

  test("rejects malformed successful responses instead of reporting zero issues", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not-json", { status: 200 }));

    await expect(probeLanguageTool({ serverUrl: "http://lt.test:8765" }))
      .rejects.toThrow("invalid JSON");
  });

  test("server probe uses draft settings and reports latency/version", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      software: { version: "6.8" },
      matches: [],
    }), { status: 200 }));

    const result = await probeLanguageTool({
      serverUrl: "https://lt.example.test/base/",
      language: "en-AU",
      level: "default",
      remoteTimeoutMs: 1_500,
    });

    expect(result).toMatchObject({
      ok: true,
      serverUrl: "https://lt.example.test/base",
      version: "6.8",
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://lt.example.test/base/v2/check");
    const body = String(init?.body || "");
    expect(body).toContain("language=en-AU");
    expect(body).toContain("level=default");
  });

  test("English checks ignore Chinese diagnostics but retain English in mixed prose", () => {
    const source = "中文直觉：只能重排，but this are wrong.";
    const comma = source.indexOf("，");
    const english = source.indexOf("this are");
    const output = JSON.stringify({ matches: [
      { offset: comma, length: 1, message: "Comma", rule: { id: "COMMA" } },
      { offset: english, length: 8, message: "Agreement", rule: { id: "AGREEMENT" } },
    ] });
    expect(parseLanguageToolDiagnostics(output, source, "en-US")).toEqual([
      expect.objectContaining({ from: english, word: "this are" }),
    ]);
  });

  test("automatic checks return NAS failure without starting local fallback", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("NAS offline"));

    const result = await runExternalProseChecks({
      requestId: "auto-no-cli",
      segments: [{ from: 0, text: "This are wrong." }],
      totalChars: 15,
      allowLocalFallback: false,
    }) as { tools?: Array<{ ok?: boolean; message?: string }> };

    expect(result.tools).toEqual([expect.objectContaining({
      ok: false,
      message: expect.stringContaining("NAS LanguageTool unavailable"),
    })]);
  });

  test("sends masked technical syntax as interpreted markup", async () => {
    let requestData = "";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      requestData = new URLSearchParams(String(init?.body || "")).get("data") || "";
      return new Response(JSON.stringify({ matches: [] }), { status: 200 });
    });
    const source = "Since \\(T_G\\) is decomposable.\nSuch that\n\\[\nU = U_1 \\oplus U_2\n\\]\nis a basis.";
    await runExternalProseChecks({
      requestId: "annotated-math",
      segments: [{ from: 0, text: source }],
      totalChars: source.length,
      allowLocalFallback: false,
    });
    const data = JSON.parse(requestData) as { annotation: Array<{ text?: string; markup?: string; interpretAs?: string }> };
    expect(data.annotation).toContainEqual({ markup: "\\(T_G\\)", interpretAs: "term" });
    expect(data.annotation).toContainEqual({ markup: "\\[\nU = U_1 \\oplus U_2\n\\]", interpretAs: "term" });
    expect(data.annotation.map((entry) => entry.text || entry.markup || "").join("")).toBe(source);
  });

  test("cancels an in-flight remote request by request id", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));

    const check = runExternalProseChecks({
      requestId: "cancel-me",
      segments: [{ from: 0, text: "This are wrong." }],
      totalChars: 15,
      allowLocalFallback: false,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(cancelExternalProseCheck("cancel-me")).toMatchObject({ ok: true, cancelled: true });
    await expect(check).rejects.toMatchObject({ name: "AbortError" });
  });

  test("caps NAS concurrency and prioritizes manual work independently of CLI fallback", async () => {
    const pending = new Map<string, (response: Response) => void>();
    const starts: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
      const body = new URLSearchParams(String(init?.body || ""));
      const data = JSON.parse(body.get("data") || '{"annotation":[]}') as {
        annotation: Array<{ text?: string; markup?: string }>;
      };
      const text = data.annotation.map((entry) => entry.text || entry.markup || "").join("");
      starts.push(text);
      return new Promise<Response>((resolve) => pending.set(text, resolve));
    });
    const run = (text: string, interactive = false) => runExternalProseChecks({
      requestId: `queue-${text}`,
      segments: [{ from: 0, text }],
      totalChars: text.length,
      allowLocalFallback: false,
      interactive,
    });
    const auto1 = run("auto-one");
    const auto2 = run("auto-two");
    await flushAsync();
    expect(starts).toEqual(expect.arrayContaining(["auto-one", "auto-two"]));
    const auto3 = run("auto-three");
    const manual = run("manual", true);
    await flushAsync();
    expect(starts).toHaveLength(2);

    const ok = () => new Response(JSON.stringify({ matches: [] }), { status: 200 });
    pending.get("auto-one")!(ok());
    await flushAsync();
    expect(starts[2]).toBe("manual");

    pending.get("manual")!(ok());
    await flushAsync();
    expect(starts[3]).toBe("auto-three");
    pending.get("auto-two")!(ok());
    pending.get("auto-three")!(ok());
    await Promise.all([auto1, auto2, auto3, manual]);
  });

  test("classifies issues into the LanguageTool classes and keeps the card text", () => {
    expect(languageToolCategory({ rule: { issueType: "misspelling" } })).toBe("spelling");
    expect(languageToolCategory({ rule: { category: { id: "TYPOS" } } })).toBe("spelling");
    expect(languageToolCategory({ rule: { issueType: "style" } })).toBe("style");
    expect(languageToolCategory({ rule: { category: { id: "REDUNDANCY" } } })).toBe("style");
    expect(languageToolCategory({ rule: { issueType: "grammar" } })).toBe("grammar");
    expect(languageToolCategory({ rule: { issueType: "typographical" } })).toBe("typography");
    expect(languageToolCategory({ rule: { category: { id: "PUNCTUATION" } } })).toBe("punctuation");
    expect(languageToolCategory({ rule: { category: { id: "CONFUSED_WORDS" } } })).toBe("word");
    const output = JSON.stringify({ matches: [{
      offset: 0,
      length: 4,
      message: "Possible spelling mistake found.",
      shortMessage: "Spelling mistake",
      replacements: [{ value: "Teh" }],
      rule: {
        id: "MORFOLOGIK_RULE_EN_US",
        description: "Possible spelling mistake",
        issueType: "misspelling",
        category: { id: "TYPOS", name: "Possible Typo" },
        urls: [{ value: "https://example.test/rule" }],
      },
    }] });
    expect(parseLanguageToolDiagnostics(output, "Tehh word")[0]).toMatchObject({
      category: "spelling",
      categoryLabel: "Possible Typo",
      title: "Spelling mistake",
      ruleDescription: "Possible spelling mistake",
      url: "https://example.test/rule",
    });
  });

  test("re-sends only the paragraph an edit touched", async () => {
    const sent: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const data = JSON.parse(new URLSearchParams(String(init?.body || "")).get("data") || "{}") as {
        annotation: Array<{ text?: string; markup?: string }>;
      };
      const text = data.annotation.map((entry) => entry.text ?? entry.markup ?? "").join("");
      sent.push(text);
      const offset = text.indexOf("this are");
      return new Response(JSON.stringify({
        matches: offset < 0 ? [] : [{ offset, length: 8, message: "Agreement", rule: { id: "AGREEMENT" } }],
      }), { status: 200 });
    });
    const run = async (text: string) => await runExternalProseChecks({
      requestId: `cache-${sent.length}`,
      segments: [{ from: 10, text }],
      totalChars: text.length + 10,
      allowLocalFallback: false,
    }) as { diagnostics: Array<{ from: number; to: number }>; scope: { cachedParagraphs: number } };

    const first = "But this are wrong.\n\nSecond paragraph stays.";
    const one = await run(first);
    expect(sent).toHaveLength(1);
    expect(one.diagnostics).toEqual([expect.objectContaining({ from: 14, to: 22 })]);

    const again = await run(first);
    expect(sent).toHaveLength(1);
    expect(again.diagnostics).toEqual(one.diagnostics);
    expect(again.scope.cachedParagraphs).toBe(2);

    const edited = "But this are wrong.\n\nSecond paragraph changed.";
    const three = await run(edited);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe("Second paragraph changed.");
    expect(three.diagnostics).toEqual([expect.objectContaining({ from: 14, to: 22 })]);
  });

  test("does not cache a failed request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("NAS offline"));
    const body = {
      segments: [{ from: 0, text: "Retry this text." }],
      totalChars: 16,
      allowLocalFallback: false,
    };
    await runExternalProseChecks({ ...body, requestId: "fail-1" });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ matches: [] }), { status: 200 }));
    await runExternalProseChecks({ ...body, requestId: "fail-2" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
