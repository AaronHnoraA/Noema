import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { createLocalGraphPanel } from "../aaronnote/local-graph.ts";
import type { NoteSummary } from "../aaronnote/types.ts";

function note(partial: Partial<NoteSummary> & Pick<NoteSummary, "id" | "title">): NoteSummary {
  return {
    key: partial.id,
    file: `/notes/${partial.id}.md`,
    path: `${partial.id}.md`,
    refs: [],
    backlinks: [],
    tags: [],
    roam: true,
    ...partial,
  };
}

function input(type: string, checked = false, value = ""): HTMLInputElement {
  const element = document.createElement("input");
  element.type = type;
  element.checked = checked;
  element.value = value;
  return element;
}

describe("local graph", () => {
  test("uses roam meta tags and renders tag-tag plus tag-file edges", () => {
    const root = document.createElement("aside");
    root.className = "aaronnote-local-graph-panel is-collapsed";
    const toggleButton = document.createElement("button");
    const depthInput = input("range", false, "2");
    const depthLabel = document.createElement("span");
    const refsInput = input("checkbox", false);
    const backlinksInput = input("checkbox", false);
    const tagsInput = input("checkbox", true);
    const canvas = document.createElement("div");
    const status = document.createElement("div");
    document.body.append(root, toggleButton, canvas);

    const current = note({ id: "current", title: "Current", tags: ["old-index-tag"], inlineTags: ["inline-index-tag"] });
    const related = note({ id: "related", title: "Related", tags: ["beta", "gamma"] });
    const markdown = [
      "#+begin meta",
      "id: current",
      "title: Current",
      "tags: alpha, beta",
      "#+end meta",
      "",
      "Body @@tag[inline-anchor] #hash-anchor",
    ].join("\n");

    const panel = createLocalGraphPanel({
      root,
      toggleButton,
      depthInput,
      depthLabel,
      refsInput,
      backlinksInput,
      tagsInput,
      canvas,
      status,
      getNotes: () => [current, related],
      getCurrentNote: () => current,
      getMarkdown: () => markdown,
      resolveNoteRef: (ref) => [current, related].find((item) => item.id === ref || item.path === ref),
      openNote: () => {},
      openTag: () => {},
    });

    try {
      panel.toggle();
      const labels = Array.from(canvas.querySelectorAll("text")).map((el) => el.textContent || "");
      expect(labels).toEqual(expect.arrayContaining(["Current", "Related", "#alpha", "#beta", "#gamma"]));
      expect(labels).not.toContain("#old-index-tag");
      expect(labels).not.toContain("#inline-index-tag");
      expect(labels).not.toContain("#inline-anchor");
      expect(labels).not.toContain("#hash-anchor");
      expect(canvas.querySelectorAll(".aaronnote-local-graph-link.is-tag").length).toBeGreaterThanOrEqual(4);
    } finally {
      panel.collapse();
      root.remove();
      toggleButton.remove();
      canvas.remove();
    }
  });
});
