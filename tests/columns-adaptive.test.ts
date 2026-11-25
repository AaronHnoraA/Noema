import { expect, test } from "@voidzero-dev/vite-plus-test";
import { layoutAdaptiveColumns, parseAdaptiveColumns } from "../shared/columns-adaptive.mjs";

const metrics = { ch: 10, em: 16, rem: 16, lh: 24 };
const panes = [1, 1, 1];

test("equal columns reduce the number of tracks and preserve source order", () => {
  const spec = parseAdaptiveColumns({columns:"3", gap:"2ch", padding:"2ch", "min-width":"24ch"});
  expect(spec).not.toBeNull();
  const layout = (width: number) => layoutAdaptiveColumns(spec!, panes, {width, ...metrics});
  expect(layout(920).rows).toEqual([[280, 280, 280]]);
  expect(layout(630).rows).toEqual([[300, 300], [610]]);
  expect(layout(345).rows).toEqual([[325], [325], [325]]);
  expect(layout(345).padding).toBe(10);
});

test("mixed tracks stay together or stack, with optional row wrapping", () => {
  const attrs = {tracks:"24ch 2fr 25%", gap:"2ch", "min-width":"16ch"};
  const layout = (width: number, wrap = false) => layoutAdaptiveColumns(
    parseAdaptiveColumns({...attrs, wrap:String(wrap)})!, panes, {width, ...metrics},
  );
  expect(layout(920).rows).toEqual([[240, 420, 220]]);
  expect(layout(530).rows).toEqual([[530], [530], [530]]);
  expect(layout(530, true).rows).toEqual([[240, 280], [530]]);
});

test("pane growth affects only fractional tracks", () => {
  const spec = parseAdaptiveColumns({tracks:"20ch 1fr 1fr", gap:"2ch", "min-width":"12ch"});
  expect(layoutAdaptiveColumns(spec!, [9, 2, 1], {width:900, ...metrics}).rows).toEqual([[200, 440, 220]]);
});
