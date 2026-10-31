import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

// @ts-ignore The HTTP transport helper is Node ESM outside the TypeScript app graph.
import { localClientRequest } from "../server/infrastructure/local-boundary.mjs";

describe("local host boundary", () => {
  test("accepts tools without an origin and the host's own pages", () => {
    expect(localClientRequest({ host: "127.0.0.1:50815" })).toBe(true);
    expect(localClientRequest({ host: "localhost:50815" })).toBe(true);
    expect(localClientRequest({ host: "[::1]:50815" })).toBe(true);
    expect(localClientRequest({
      host: "127.0.0.1:50815", origin: "http://127.0.0.1:50815",
    })).toBe(true);
  });

  test("refuses another page, a sandboxed frame and a rebound name", () => {
    expect(localClientRequest({
      host: "127.0.0.1:50815", origin: "https://evil.example",
    })).toBe(false);
    expect(localClientRequest({ host: "127.0.0.1:50815", origin: "null" })).toBe(false);
    expect(localClientRequest({
      host: "127.0.0.1:50815", origin: "http://127.0.0.1:9999",
    })).toBe(false);
    expect(localClientRequest({ host: "evil.example:50815" })).toBe(false);
    expect(localClientRequest({
      host: "evil.example:50815", origin: "http://evil.example:50815",
    })).toBe(false);
    expect(localClientRequest({})).toBe(false);
  });

  test("a bearer route takes a browser extension, never a rebound name", () => {
    const extension = "chrome-extension://abcdefghijklmnop";
    expect(localClientRequest(
      { host: "127.0.0.1:50815", origin: extension }, { bearerRoute: true },
    )).toBe(true);
    expect(localClientRequest(
      { host: "evil.example", origin: extension }, { bearerRoute: true },
    )).toBe(false);
  });
});
