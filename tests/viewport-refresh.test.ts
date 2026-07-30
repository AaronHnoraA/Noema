import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("viewport refresh performance contract", () => {
  test("never settles parsing across the full document", () => {
    const source = readFileSync(join(process.cwd(), "src", "cm6", "viewport-refresh.ts"), "utf8");
    expect(source).not.toContain("forceParsing");
    expect(source).not.toContain("SETTLE_DEADLINE_MS");
    expect(source).toContain("VIEWPORT_PARSE_BUDGET_MS = 8");
    expect(source).toContain("VIEWPORT_OVERSCAN_CHARS = 16 * 1024");
  });
});
