import { describe, it, expect } from "@voidzero-dev/vite-plus-test";
import { parseAttrArgs } from "../src/attrs-syntax.ts";
import {
  imageLayoutFromAttrs,
  imageLayoutToTrailingAttrs,
  type ImageLayoutAttrs,
} from "../src/image-attrs.ts";

const base: ImageLayoutAttrs = { align: "center", wrap: false, width: "", height: "" };

function roundTrip(layout: ImageLayoutAttrs): ImageLayoutAttrs {
  const text = imageLayoutToTrailingAttrs(layout);
  return imageLayoutFromAttrs(parseAttrArgs(text));
}

describe("imageLayoutToTrailingAttrs", () => {
  it("serializes the default layout to an empty string", () => {
    expect(imageLayoutToTrailingAttrs(base)).toBe("");
  });

  it("emits align for non-wrapping left/right blocks", () => {
    expect(imageLayoutToTrailingAttrs({ ...base, align: "left" })).toBe("{align: left}");
    expect(imageLayoutToTrailingAttrs({ ...base, align: "right" })).toBe("{align: right}");
  });

  it("emits wrap for floated images", () => {
    expect(imageLayoutToTrailingAttrs({ ...base, align: "left", wrap: true })).toBe("{wrap: left}");
    expect(imageLayoutToTrailingAttrs({ ...base, align: "right", wrap: true })).toBe("{wrap: right}");
  });

  it("emits width / height and combines with align", () => {
    expect(imageLayoutToTrailingAttrs({ ...base, width: "50%" })).toBe("{width: 50%}");
    expect(imageLayoutToTrailingAttrs({ ...base, align: "left", width: "50%" })).toBe(
      "{align: left, width: 50%}",
    );
  });
});

describe("image layout round-trips through imageLayoutFromAttrs", () => {
  const cases: ImageLayoutAttrs[] = [
    base,
    { ...base, align: "left" },
    { ...base, align: "right" },
    { ...base, align: "left", wrap: true },
    { ...base, align: "right", wrap: true },
    { ...base, width: "50%" },
    { ...base, align: "left", width: "75%" },
  ];
  for (const layout of cases) {
    it(`round-trips ${JSON.stringify(layout)}`, () => {
      expect(roundTrip(layout)).toEqual(layout);
    });
  }
});
