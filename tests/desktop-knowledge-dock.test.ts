import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import {
  createDesktopKnowledgeDock,
  projectKnowledgeBacklinks,
} from "../aaronnote/desktop-knowledge-dock.ts";
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

function dockFixture(current: NoteSummary, notes: NoteSummary[]) {
  const root = document.createElement("aside");
  root.className = "is-collapsed";
  const visibilityButton = document.createElement("button");
  const backlinkList = document.createElement("div");
  const backlinkStatus = document.createElement("div");
  const tagList = document.createElement("div");
  const tagStatus = document.createElement("div");
  const searchInput = document.createElement("input");
  const panes = {
    backlinks: document.createElement("section"),
    graph: document.createElement("section"),
    search: document.createElement("section"),
    tags: document.createElement("section"),
  };
  const tabButtons = (["backlinks", "graph", "search", "tags"] as const).map((view) => {
    const button = document.createElement("button");
    button.dataset.knowledgeView = view;
    return button;
  });
  root.append(...tabButtons, panes.backlinks, panes.graph, panes.search, panes.tags);
  panes.backlinks.append(backlinkStatus, backlinkList);
  panes.search.append(searchInput);
  panes.tags.append(tagStatus, tagList);
  document.body.append(root, visibilityButton);
  const calls = { visible: 0, hidden: 0, collapsed: 0 };
  const opened: Array<{ note: NoteSummary; newWindow: boolean }> = [];
  const openedTags: string[] = [];
  const states: Array<{ view: string; expanded: boolean }> = [];
  const controller = createDesktopKnowledgeDock({
    root,
    body: document.body,
    visibilityButton,
    tabButtons,
    panes,
    backlinkList,
    backlinkStatus,
    tagList,
    tagStatus,
    searchInput,
    getCurrentNote: () => current,
    resolveNoteRef: (ref) => notes.find((item) => [item.key, item.id, item.file, item.path, item.title].includes(ref)),
    relationshipSource: () => "kernel-refs",
    openNote: (target, options) => opened.push({ note: target, newWindow: Boolean(options?.newWindow) }),
    getTags: () => [
      { name: "proof", count: 2, current: true },
      { name: "research", count: 5 },
    ],
    openTag: (tag) => openedTags.push(tag),
    onStateChange: (view, expanded) => states.push({ view, expanded }),
    onGraphVisible: () => { calls.visible += 1; },
    onGraphHidden: () => { calls.hidden += 1; },
    onCollapse: () => { calls.collapsed += 1; root.classList.add("is-collapsed"); },
  });
  return {
    controller,
    root,
    visibilityButton,
    backlinkList,
    backlinkStatus,
    tagList,
    tagStatus,
    searchInput,
    panes,
    tabButtons,
    calls,
    opened,
    openedTags,
    states,
  };
}

describe("desktop knowledge dock", () => {
  test("projects resolved backlinks once and preserves unresolved refs", () => {
    const source = note({ id: "source", title: "Source", tags: ["proof"] });
    const current = note({ id: "current", title: "Current", backlinks: ["source", "source.md", "missing", "MISSING"] });
    const projected = projectKnowledgeBacklinks(current, (ref) => [source].find((item) => [item.id, item.path].includes(ref)));

    expect(projected).toHaveLength(2);
    expect(projected[0]).toEqual(expect.objectContaining({ key: "source", title: "Source", note: source }));
    expect(projected[1]).toEqual(expect.objectContaining({ key: "missing:missing", title: "missing", note: undefined }));
  });

  test("coordinates dock tabs, graph lifecycle, search focus, and close state", async () => {
    const source = note({ id: "source", title: "Source" });
    const current = note({ id: "current", title: "Current", backlinks: ["source"] });
    const fixture = dockFixture(current, [source, current]);
    try {
      fixture.controller.show("backlinks");
      expect(fixture.root.classList.contains("is-collapsed")).toBe(false);
      expect(document.body.classList.contains("noema-knowledge-dock-open")).toBe(true);
      expect(fixture.visibilityButton.getAttribute("aria-expanded")).toBe("true");
      expect(fixture.backlinkStatus.textContent).toBe("1 backlink · kernel refs");
      expect(fixture.backlinkList.querySelector("strong")?.textContent).toBe("Source");

      fixture.controller.show("graph");
      expect(fixture.controller.activeView()).toBe("graph");
      expect(fixture.calls.visible).toBe(1);
      expect(fixture.panes.graph.hidden).toBe(false);

      fixture.controller.show("search");
      await Promise.resolve();
      expect(fixture.calls.hidden).toBe(1);
      expect(document.activeElement).toBe(fixture.searchInput);
      expect(fixture.tabButtons[2]?.getAttribute("aria-selected")).toBe("true");

      fixture.controller.toggle("search");
      expect(fixture.calls.collapsed).toBe(1);
      expect(fixture.root.classList.contains("is-collapsed")).toBe(true);
      expect(document.body.classList.contains("noema-knowledge-dock-open")).toBe(false);
      expect(document.activeElement).not.toBe(fixture.searchInput);
      expect(fixture.states.at(-1)).toEqual({ view: "search", expanded: false });
    } finally {
      fixture.controller.destroy();
      fixture.root.remove();
      fixture.visibilityButton.remove();
      document.body.className = "";
    }
  });

  test("separates current and workspace tags and opens the portable tag filter", () => {
    const current = note({ id: "current", title: "Current", tags: ["proof"] });
    const fixture = dockFixture(current, [current]);
    try {
      fixture.controller.show("tags");
      expect(fixture.tagStatus.textContent).toBe("1 current · 2 workspace tags");
      expect([...fixture.tagList.querySelectorAll(".noema-knowledge-tag-heading")].map((item) => item.textContent))
        .toEqual(["Current note", "Workspace"]);
      const buttons = [...fixture.tagList.querySelectorAll<HTMLButtonElement>("button")];
      expect(buttons.map((button) => button.textContent)).toEqual(["#proof2", "#research5"]);
      buttons[1]?.click();
      expect(fixture.openedTags).toEqual(["research"]);
    } finally {
      fixture.controller.destroy();
      fixture.root.remove();
      fixture.visibilityButton.remove();
      document.body.className = "";
    }
  });

  test("opens resolved backlink cards in the requested window", () => {
    const source = note({ id: "source", title: "Source" });
    const current = note({ id: "current", title: "Current", backlinks: ["source"] });
    const fixture = dockFixture(current, [source, current]);
    try {
      fixture.controller.show("backlinks");
      fixture.backlinkList.querySelector<HTMLButtonElement>("button")?.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        metaKey: true,
      }));
      expect(fixture.opened).toEqual([{ note: source, newWindow: true }]);
    } finally {
      fixture.controller.destroy();
      fixture.root.remove();
      fixture.visibilityButton.remove();
      document.body.className = "";
    }
  });
});
