import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, test, vi } from "@voidzero-dev/vite-plus-test";

// @ts-ignore Node ESM module outside the TS app graph.
import { noemaMarkdownToLatexPandoc } from "../server/lib/latex-export-pandoc.mjs";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const mocked = { ...actual, spawn: vi.fn() };
  return { ...mocked, default: mocked };
});
afterEach(() => vi.resetAllMocks());

function pandocOutput(stdout: string, stderr = "", code = 0) {
  vi.mocked(spawn).mockImplementationOnce(() => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    child.stdin.on("finish", () => {
      // Each UTF-8 byte is a separate chunk, including within 2/3/4-byte glyphs.
      for (const byte of Buffer.from(stdout, "utf8")) child.stdout.write(Buffer.from([byte]));
      for (const byte of Buffer.from(stderr, "utf8")) child.stderr.write(Buffer.from([byte]));
      child.stdout.end();
      child.stderr.end();
      child.emit("close", code);
    });
    return child as unknown as ReturnType<typeof spawn>;
  });
}

describe("LaTeX export Pandoc UTF-8 stream fidelity (C1)", () => {
  test("preserves Unicode prose and math when stdout splits inside characters", async () => {
    const body = "\\section{导师选择}\n中文 café \\(𝛼\\)\n";
    pandocOutput(body);

    const converted = await noemaMarkdownToLatexPandoc("# 导师选择\n\n中文 café \\(𝛼\\)");

    expect(converted.body).toBe(body);
    expect(converted.body).not.toContain("\uFFFD");
  });

  test("preserves UTF-8 diagnostics when stderr splits inside characters", async () => {
    const diagnostic = "无法转换：café 𝛼";
    pandocOutput("", diagnostic, 1);

    await expect(noemaMarkdownToLatexPandoc("中文"))
      .rejects.toThrow(`Pandoc Markdown→LaTeX conversion failed: ${diagnostic}`);
  });
});
