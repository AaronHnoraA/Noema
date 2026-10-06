import { expect, test } from "@voidzero-dev/vite-plus-test";
import { sortTableBodyRows, tableRowsToCSV } from "../../src/cm6/table-model.ts";

test("CSV export quotes commas and quotes and restores escaped Markdown pipes", () => {
  expect(tableRowsToCSV([["Name", "Detail"], ["A, B", 'said "yes"'], ["C", "x\\|y"]]))
    .toBe('Name,Detail\r\n"A, B","said ""yes"""\r\nC,x|y');
});

test("table sorting is stable for equal numeric keys", () => {
  expect(sortTableBodyRows([["Name", "Score"], ["B", "2"], ["A", "10"], ["C", "2"]], 1, 1, (row) => row))
    .toEqual([["Name", "Score"], ["B", "2"], ["C", "2"], ["A", "10"]]);
});
