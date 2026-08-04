import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import {
  collectTagSuggestions,
  createTagPicker,
  filterTagSuggestions,
  normalizeCreatedTag,
  parseTagPickerValue,
} from "../aaronnote/tag-picker.ts";
import {
  metadataTagsFromMarkdown,
  planMarkdownMetadataChanges,
  planMarkdownTagChanges,
  tagChangesBetween,
} from "../aaronnote/note-tag-transaction.ts";

describe("interactive tag picker", () => {
  test("normalizes tags and ranks prefix matches before substring matches", () => {
    expect(parseTagPickerValue("#Math, logic math")).toEqual(["Math", "logic"]);
    expect(filterTagSuggestions(["homological", "math", "metamathematics"], "mat"))
      .toEqual(["math", "metamathematics"]);
    expect(normalizeCreatedTag(" #linear algebra ")).toBe("linear-algebra");
    expect(collectTagSuggestions([
      { tags: ["tcs"], inlineTags: ["pcp"] },
      // Graph visibility is deliberately not part of the suggestion contract.
      { tags: ["private-tag"], roam: false } as { tags: string[]; roam: boolean },
    ])).toEqual(["pcp", "private-tag", "tcs"]);
  });

  test("uses live org or YAML metadata tags as the editor transaction baseline", () => {
    expect(metadataTagsFromMarkdown("#+begin meta\ntags: tcs, pcp\n#+end meta\n# Note\n"))
      .toEqual(["tcs", "pcp"]);
    expect(metadataTagsFromMarkdown("---\ntags:\n  - tcs\n  - complexity\n---\n# Note\n"))
      .toEqual(["tcs", "complexity"]);
    expect(metadataTagsFromMarkdown("#+begin meta\ntitle: No tags\n#+end meta\n"))
      .toBeNull();
  });

  test("models deletion as one explicit identity change", () => {
    expect(tagChangesBetween(["TCS", "IP-PCP", "complexity"], ["TCS", "complexity"]))
      .toEqual({ add: [], remove: ["IP-PCP"] });

    const content = [
      "#+begin meta",
      "id: ip-pcp",
      "plugin-field: preserve exactly  ",
      "tags: TCS, IP-PCP, complexity",
      "refs: theorem-1",
      "#+end meta",
      "",
      "# IP-PCP",
      "",
    ].join("\n");
    const edit = planMarkdownTagChanges(content, { add: [], remove: ["IP-PCP"] });
    const next = `${content.slice(0, edit.from)}${edit.insert}${content.slice(edit.to)}`;
    expect(next).toContain("plugin-field: preserve exactly  \n");
    expect(next).toContain("tags: TCS, complexity\nrefs: theorem-1");
    expect(next).not.toContain("IP-PCP, complexity");
  });

  test("merges tag intent into the latest document without touching concurrent additions", () => {
    const changes = tagChangesBetween(["tcs", "pcp"], ["pcp"]);
    const latest = "---\ntags:\n  - tcs\n  - pcp\n  - added-elsewhere\nplugin: keep\n---\n# Note\n";
    const edit = planMarkdownTagChanges(latest, changes);
    const next = `${latest.slice(0, edit.from)}${edit.insert}${latest.slice(edit.to)}`;
    expect(next).toBe("---\ntags:\n  - pcp\n  - added-elsewhere\nplugin: keep\n---\n# Note\n");
    expect(edit.tags).toEqual(["pcp", "added-elsewhere"]);
  });

  test("adds a minimal metadata block without inventing unrelated fields", () => {
    const content = "# Plain note\n";
    const edit = planMarkdownTagChanges(content, { add: ["tcs"], remove: [] });
    const next = `${content.slice(0, edit.from)}${edit.insert}${content.slice(edit.to)}`;
    expect(next).toBe("#+begin meta\ntags: tcs\n#+end meta\n\n# Plain note\n");
    expect(next).not.toContain("id:");
    expect(next).not.toContain("kind:");
  });

  test("updates project and tags as one minimal editor transaction", () => {
    const content = [
      "#+begin meta",
      "id: exact-id",
      "project: Old Project",
      "plugin-field: Preserve This  ",
      "tags: TCS, IP-PCP, complexity",
      "refs: theorem-1",
      "#+end meta",
      "",
      "# IP-PCP",
      "",
    ].join("\n");
    const edit = planMarkdownMetadataChanges(content, {
      project: "New Project",
      tags: { add: [], remove: ["IP-PCP"] },
    });
    const next = `${content.slice(0, edit.from)}${edit.insert}${content.slice(edit.to)}`;
    expect(next).toContain("id: exact-id\nproject: New Project\nplugin-field: Preserve This  \n");
    expect(next).toContain("tags: TCS, complexity\nrefs: theorem-1");
    expect(next.endsWith("# IP-PCP\n")).toBe(true);
  });

  test("removes only the project line when the form clears it", () => {
    const content = "---\ntitle: Note\nproject: Temporary\nplugin: keep\ntags: tcs\n---\n# Note\n";
    const edit = planMarkdownMetadataChanges(content, { project: "", tags: { add: [], remove: [] } });
    const next = `${content.slice(0, edit.from)}${edit.insert}${content.slice(edit.to)}`;
    expect(next).toBe("---\ntitle: Note\nplugin: keep\ntags: tcs\n---\n# Note\n");
  });

  test("filters while typing, adds with Enter, and removes selected chips", () => {
    const picker = createTagPicker({
      name: "tags",
      value: "logic",
      suggestions: ["logic", "linear-algebra", "category-theory"],
      multiple: true,
    });
    document.body.appendChild(picker.root);
    expect(picker.value()).toBe("logic");
    expect(picker.root.querySelectorAll(".aaronnote-tag-picker-chip")).toHaveLength(1);

    picker.search.value = "lin";
    picker.search.dispatchEvent(new Event("input", { bubbles: true }));
    expect([...picker.root.querySelectorAll<HTMLElement>("[data-tag]")].map((item) => item.dataset.tag))
      .toEqual(["linear-algebra"]);
    picker.search.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    picker.search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(picker.value()).toBe("logic, linear-algebra");
    expect(picker.changes()).toEqual({ add: ["linear-algebra"], remove: [] });

    picker.root.querySelector<HTMLElement>(".aaronnote-tag-picker-chip-label")!.click();
    expect(picker.value()).toBe("logic, linear-algebra");
    picker.root.querySelector<HTMLButtonElement>(".aaronnote-tag-picker-chip-remove")!.click();
    expect(picker.value()).toBe("linear-algebra");
    expect(picker.changes()).toEqual({ add: ["linear-algebra"], remove: ["logic"] });
    picker.root.remove();
  });

  test("creates a new typed tag even when existing suggestions partially match", () => {
    const picker = createTagPicker({
      name: "tags",
      suggestions: ["linear-algebra", "category-theory"],
      multiple: true,
    });
    document.body.appendChild(picker.root);
    picker.search.value = "linear";
    picker.search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(picker.root.querySelector<HTMLElement>("[data-create-tag]")?.dataset.createTag).toBe("linear");
    picker.search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(picker.value()).toBe("linear");

    picker.search.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
    expect(picker.value()).toBe("linear");
    picker.root.querySelector<HTMLButtonElement>(".aaronnote-tag-picker-chip-remove")!.click();
    expect(picker.value()).toBe("");
    picker.root.remove();
  });

  test("keeps spaces in the search draft and normalizes only on explicit commit", () => {
    const picker = createTagPicker({ name: "tags", multiple: true });
    document.body.appendChild(picker.root);
    picker.search.value = "linear";
    picker.search.dispatchEvent(new Event("input", { bubbles: true }));
    picker.search.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    picker.search.value = "linear algebra";
    picker.search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(picker.value()).toBe("");
    picker.search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(picker.value()).toBe("linear-algebra");
    picker.root.remove();
  });

  test("single-tag mode writes the live query and accepts a suggested tag", () => {
    const picker = createTagPicker({
      name: "tag",
      suggestions: ["analysis", "algebra"],
      multiple: false,
      allowCreate: false,
    });
    document.body.appendChild(picker.root);
    picker.search.value = "alg";
    picker.search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(picker.value()).toBe("alg");
    picker.search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(picker.value()).toBe("algebra");
    picker.root.remove();
  });
});
