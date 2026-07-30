import { afterEach, describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

// @ts-ignore The server is a Node ESM module outside the TS app graph.
import { parseSnippetBody, scanSnippets } from "../server/lib/runtime.mjs";

type ScannedSnippet = {
  id?: string;
  key?: string;
  provider?: string;
  priority?: number;
  weight?: number;
  context?: string;
  description?: string;
  browserCompatible?: boolean;
};

const originalRoots = process.env.AARONNOTE_SNIPPETS;

afterEach(() => {
  if (originalRoots == null) delete process.env.AARONNOTE_SNIPPETS;
  else process.env.AARONNOTE_SNIPPETS = originalRoots;
});

describe("server snippet catalog", () => {
  test("preserves intentional body whitespace", () => {
    const parsed = parseSnippetBody("# key: x\n# --\nbody  \n\n");
    expect(parsed.body).toBe("body  \n");
  });

  test("uses explicit priority, merges upstream weight, and classifies backtick snippets", async () => {
    const root = await mkdtemp(join(tmpdir(), "aaronnote-snippets-"));
    const personal = join(root, "personal", "tex-mode");
    const upstream = join(root, "upstream", "tex-mode");
    await mkdir(personal, { recursive: true });
    await mkdir(upstream, { recursive: true });
    await writeFile(join(personal, "alpha"), "# key: alpha\n# provider: personal\n# priority: 500\n# --\n\\alpha$0\n");
    await writeFile(join(upstream, "alpha"), "# key: alpha\n# provider: overleaf\n# priority: 160\n# weight: 7.5\n# --\n\\alpha$0\n");
    await writeFile(join(personal, "unsafe"), "# key: unsafe\n# --\n`(message \\\"x\\\")`\n");
    await writeFile(join(personal, "inline-code"), "# key: icode\n# --\n`$1` $0\n");
    process.env.AARONNOTE_SNIPPETS = [join(root, "personal"), join(root, "upstream")].join(delimiter);

    const snippets = await scanSnippets({ force: true });
    const alpha = snippets.find((snippet: ScannedSnippet) => snippet.key === "alpha");
    expect(alpha?.provider).toBe("personal");
    expect(alpha?.weight).toBe(7.5);
    expect(snippets.find((snippet: ScannedSnippet) => snippet.key === "unsafe")?.browserCompatible).toBe(false);
    expect(snippets.find((snippet: ScannedSnippet) => snippet.key === "icode")?.browserCompatible).toBe(true);
  });

  test("decodes generated metadata from YAS-native headers", async () => {
    const root = await mkdtemp(join(tmpdir(), "aaronnote-generated-snippets-"));
    const tex = join(root, "tex-mode");
    await mkdir(tex, { recursive: true });
    await writeFile(join(tex, "beta"), [
      "# name: beta",
      "# key: @b",
      "# uuid: latex-workshop:@b",
      "# contributor: Noema provider=latex-workshop&priority=180&weight=2.5&context=math-at&description=Greek+beta",
      "# --",
      "\\beta",
      "",
    ].join("\n"));
    process.env.AARONNOTE_SNIPPETS = root;

    const beta = (await scanSnippets({ force: true }))
      .find((snippet: ScannedSnippet) => snippet.key === "@b");
    expect(beta).toMatchObject({
      id: "latex-workshop:@b",
      provider: "latex-workshop",
      priority: 180,
      weight: 2.5,
      context: "math-at",
      description: "Greek beta",
    });
  });
});
