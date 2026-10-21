import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

// @ts-ignore Node ESM module outside the TS app graph.
import { claudeExportDnsError } from "../server/lib/latex-agent-connectivity.mjs";

describe("Claude export connectivity", () => {
  test("reports a failed DNS lookup before an ACP prompt is sent", async () => {
    const result = await claudeExportDnsError({
      backend: "claude", environment: {},
      lookupHost: async () => { throw Object.assign(new Error("not found"), { code: "ENOTFOUND" }); },
    });
    expect(result).toContain("ENOTFOUND");
    expect(result).toContain("select Codex");
  });

  test("bounds a stalled resolver and leaves other backends alone", async () => {
    const hung = () => new Promise(() => {});
    expect(await claudeExportDnsError({ backend: "claude", environment: {}, lookupHost: hung, timeoutMs: 5 }))
      .toContain("DNS lookup timed out");
    expect(await claudeExportDnsError({ backend: "codex", environment: {}, lookupHost: hung, timeoutMs: 5 }))
      .toBe("");
  });

  test("respects a configured proxy or provider endpoint", async () => {
    const fail = () => { throw new Error("should not look up direct host"); };
    expect(await claudeExportDnsError({ backend: "claude", environment: { HTTPS_PROXY: "http://127.0.0.1:8888" }, lookupHost: fail }))
      .toBe("");
    expect(await claudeExportDnsError({ backend: "claude", environment: { ANTHROPIC_BASE_URL: "https://gateway.example" }, lookupHost: fail }))
      .toBe("");
  });
});
