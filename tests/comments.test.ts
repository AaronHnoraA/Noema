import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import fixtures from "../shared/comment-fixtures.json";
// @ts-ignore Node source module
import { escapeCommentBody, findComment, newCommentId, scanComments, commentEdit, commentSource } from "../shared/comments.mjs";

describe("C79 side comments", () => {
  test("C79 fixtures: id, done, text, line and the passage before", () => {
    for (const fixture of fixtures as any[]) {
      const found = scanComments(fixture.source).map(({ id, done, text, line, quote }: any) => ({ id, done, text, line, quote }));
      expect(found).toEqual(fixture.comments);
    }
  });

  test("C79 a comment round-trips through its source", () => {
    const source = `x ${commentSource({ text: "a ] b\nc", id: "k3x9qa" })} y`;
    expect(source).toBe("x @@comment [a \\] b c] {id: k3x9qa} y");
    expect(findComment(source, "K3X9QA")).toMatchObject({ text: "a ] b c", done: false });
    expect(escapeCommentBody("\\")).toBe("\\\\");
    expect(newCommentId(() => 0.5)).toMatch(/^[a-z0-9]{6}$/);
  });

  test("C79 resolving keeps the text; an id-less comment is given one", () => {
    const [old] = scanComments("@@comment [use clearer def]");
    expect(commentEdit(old, { id: "ab12cd" })).toEqual({ oldText: "@@comment [use clearer def]", newText: "@@comment [use clearer def] {id: ab12cd}" });
    const [open] = scanComments("@@comment [x] {id: ab12cd}");
    expect(commentEdit(open, { done: true }).newText).toBe("@@comment(done) [x] {id: ab12cd}");
    expect(() => commentEdit(old)).toThrow(/id/);
    // The text is never re-escaped; attributes keep their place.
    const [nested] = scanComments("@@comment [a [b] c] {by: You}");
    expect(commentEdit(nested, { id: "zz11yy", done: true }).newText).toBe("@@comment(done) [a [b] c] {id: zz11yy; by: You}");
  });
});
