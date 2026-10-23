import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { ApiRouter } from "../server/infrastructure/api-router.mjs";

describe("API feature router", () => {
  test("composes feature handlers and preserves positional arguments", async () => {
    const router = new ApiRouter().register({
      "noema:api:test:add": (left: number, right: number) => left + right,
    }, "test");
    expect(await router.call("noema:api:test:add", [2, 3])).toBe(5);
    expect(router.channels()).toEqual(["noema:api:test:add"]);
  });

  test("rejects duplicate and unknown channels", async () => {
    const router = new ApiRouter().register({ "noema:api:test": () => true });
    expect(() => router.register({ "noema:api:test": () => false })).toThrow("Duplicate API channel");
    await expect(router.call("noema:api:missing")).rejects.toMatchObject({ statusCode: 404 });
  });
});
