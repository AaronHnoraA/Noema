import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

// @ts-ignore The HTTP transport helper is Node ESM outside the TypeScript app graph.
import { foreignPage } from "../server/infrastructure/local-boundary.mjs";

const request = (origin?: string) => ({
  headers: origin === undefined ? {} : { origin },
  socket: { localPort: 50815 },
});

describe("local host boundary", () => {
  test("accepts tools without an origin and the host's own pages", () => {
    expect(foreignPage(request())).toBe(false);
    expect(foreignPage(request("http://127.0.0.1:50815"))).toBe(false);
  });

  test("refuses another page, a sandboxed frame and a rebound domain", () => {
    expect(foreignPage(request("https://evil.example"))).toBe(true);
    expect(foreignPage(request("null"))).toBe(true);
    expect(foreignPage(request("http://127.0.0.1:9999"))).toBe(true);
    expect(foreignPage(request("http://evil.example:50815"))).toBe(true);
  });
});
