import { Readable } from "node:stream";
import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

// @ts-ignore The HTTP transport helper is Node ESM outside the TypeScript app graph.
import { readJson } from "../server/infrastructure/http-body.mjs";

function splitRequest(bytes: Buffer, cuts: number[]): Readable {
  const chunks: Buffer[] = [];
  let from = 0;
  for (const to of cuts) {
    chunks.push(bytes.subarray(from, to));
    from = to;
  }
  chunks.push(bytes.subarray(from));
  return Readable.from(chunks);
}

describe("HTTP request bodies", () => {
  test("preserves UTF-8 when network chunks split Chinese characters", async () => {
    const payload = {
      channel: "aaronnote:api:notes:save",
      args: [{
        content: "证明 tensor direct-sum decomposition；陈述 support hypergraph。",
      }],
    };
    const bytes = Buffer.from(JSON.stringify(payload));
    const proof = bytes.indexOf(Buffer.from("证"));
    const statement = bytes.indexOf(Buffer.from("陈"));

    // Exercise both failure shapes from the damaged note: a split after two
    // bytes used to produce two U+FFFD characters, while a split after one
    // byte used to produce three.
    const parsed = await readJson(splitRequest(bytes, [proof + 2, statement + 1]));

    expect(parsed).toEqual(payload);
    expect(parsed.args[0].content).not.toContain("�");
  });

  test("rejects malformed UTF-8 instead of allowing replacement characters into a save", async () => {
    const bytes = Buffer.concat([
      Buffer.from('{"content":"'),
      Buffer.from([0xe8, 0xaf]),
      Buffer.from('"}'),
    ]);

    await expect(readJson(Readable.from([bytes]))).rejects.toMatchObject({
      statusCode: 400,
      message: "Request body is not valid UTF-8",
    });
  });

  test("applies request limits to encoded bytes", async () => {
    const bytes = Buffer.from(JSON.stringify({ content: "证明" }));

    await expect(readJson(Readable.from([bytes]), bytes.length - 1)).rejects.toMatchObject({
      statusCode: 413,
      message: "Request body too large",
    });
  });
});
