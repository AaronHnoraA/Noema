import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import {
  inlineTagFromHash,
  inlineTagHash,
  markdownRoamIdLink,
  resolveRoamNoteSearch,
  roamHrefForNote,
  roamNoteInputRef,
  roamNoteSearchValue,
} from "../aaronnote/roam-idlink.ts";
import type { NoteSummary } from "../aaronnote/types.ts";

const density: NoteSummary = {
  id: "20260520T120000-density-operator",
  title: "Density Operator",
  path: "QC/density_operator.md",
  tags: ["quantum"],
  aliases: ["density matrix"],
  roam: true,
};
const notes: NoteSummary[] = [
  density,
  {
    id: "plain-file",
    title: "Plain File",
    path: "plain.md",
    roam: false,
  },
];

describe("roam idlink helpers", () => {
  test("builds canonical roam hrefs with equation hashes", () => {
    expect(roamHrefForNote(density, "eq-eq%3A1")).toBe("roam://20260520T120000-density-operator#eq-eq%3A1");
  });

  test("builds and decodes inline anchor hashes", () => {
    expect(inlineTagHash("section anchor")).toBe("tag-section%20anchor");
    expect(inlineTagFromHash("#tag-section%20anchor")).toBe("section anchor");
  });

  test("extracts note ids from plain, href, and suggestion inputs", () => {
    expect(roamNoteInputRef("roam://20260520T120000-density-operator#eq-x")).toBe("20260520T120000-density-operator");
    expect(roamNoteInputRef("roam://20260520T120000-density-operator@main-heading")).toBe("20260520T120000-density-operator");
    expect(roamNoteInputRef(roamNoteSearchValue(density))).toBe("20260520T120000-density-operator");
  });

  test("resolves roam notes by title, id, path, alias, or tag", () => {
    expect(resolveRoamNoteSearch(notes, "Density Operator")?.id).toBe(density.id);
    expect(resolveRoamNoteSearch(notes, "density matrix")?.id).toBe(density.id);
    expect(resolveRoamNoteSearch(notes, "quantum")?.id).toBe(density.id);
    expect(resolveRoamNoteSearch(notes, "Plain File")).toBeUndefined();
  });

  test("inserts markdown links backed by roam hrefs", () => {
    expect(markdownRoamIdLink(density, "see [density]")).toBe("[see \\[density\\]](roam://20260520T120000-density-operator)");
  });
});
