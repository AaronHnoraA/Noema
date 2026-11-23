import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { trashLinkNotice } from "../pages/trash-notice.ts";

const notes = [
  { id: "a", title: "Alpha", file: "/v/a.md", backlinks: ["b", "c", "b"] },
  { id: "b", title: "Beta", file: "/v/b.md", backlinks: [] },
  { id: "c", title: "", file: "/v/c.md" },
];

describe("trashLinkNotice", () => {
  test("names the notes whose links will dangle, once each", () => {
    expect(trashLinkNotice("/v/a.md", notes)).toBe("2 notes link here and will have a dangling link: Beta, c. ");
  });

  test("says nothing when nothing links here", () => {
    expect(trashLinkNotice("/v/b.md", notes)).toBe("");
    expect(trashLinkNotice("/v/missing.md", notes)).toBe("");
  });

  test("lists at most five titles", () => {
    const many = [{ id: "x", file: "/v/x.md", backlinks: ["1", "2", "3", "4", "5", "6"] }];
    expect(trashLinkNotice("/v/x.md", many)).toBe("6 notes link here and will have a dangling link: 1, 2, 3, 4, 5, …. ");
  });
});
