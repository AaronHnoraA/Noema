import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import fixtures from "../shared/scomment-fixtures.json";
// @ts-ignore Node source module
import { escapeScommentBody, findScomment, newScommentId, scanScomments, scommentEdit, scommentSource } from "../shared/scomment.mjs";

describe("C79 side comments", () => {
  test("C79 fixtures: id, done, text, line and the passage before", () => {
    for (const fixture of fixtures as any[]) {
      const found = scanScomments(fixture.source).map(({ id, done, text, line, quote }: any) => ({ id, done, text, line, quote }));
      expect(found).toEqual(fixture.comments);
    }
  });

  test("C79 a comment round-trips through its source", () => {
    const source = `x ${scommentSource({ text: "a ] b\nc", id: "k3x9qa" })} y`;
    expect(source).toBe("x @@scomment [a \\] b c] {id: k3x9qa} y");
    expect(findScomment(source, "K3X9QA")).toMatchObject({ text: "a ] b c", done: false });
    expect(escapeScommentBody("\\")).toBe("\\\\");
    expect(newScommentId(() => 0.5)).toMatch(/^[a-z0-9]{6}$/);
  });

  test("C79 resolving keeps the text; an id-less comment is given one", () => {
    const [old] = scanScomments("@@scomment [use clearer def]");
    expect(scommentEdit(old, { id: "ab12cd" })).toEqual({ oldText: "@@scomment [use clearer def]", newText: "@@scomment [use clearer def] {id: ab12cd}" });
    const [open] = scanScomments("@@scomment [x] {id: ab12cd}");
    expect(scommentEdit(open, { done: true }).newText).toBe("@@scomment(done) [x] {id: ab12cd}");
    expect(() => scommentEdit(old)).toThrow(/id/);
    // The text is never re-escaped; attributes keep their place.
    const [nested] = scanScomments("@@scomment [a [b] c] {by: You}");
    expect(scommentEdit(nested, { id: "zz11yy", done: true }).newText).toBe("@@scomment(done) [a [b] c] {id: zz11yy; by: You}");
  });
});
