import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { createLocalGraphPanel, workspaceGraphWithCurrentMarkdown } from "../aaronnote/local-graph.ts";
import type { WorkspaceGraphOptions } from "../aaronnote/workspace-graph.ts";
import type { GraphPayload, NoteSummary } from "../aaronnote/types.ts";

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
  /**
   * Per-keystroke cost guardrail for the open graph panel.
   *
   * `changeHandlers` schedules an overlay update on every document change. The
   * signature used to fold in the raw Markdown length, which changes on every
   * typed character, so an editing pause forced a full rebuild and cytoscape
   * layout even though the graph could not differ. Electron absorbs that; the
   * Emacs xwidget, which repaints the widget through Emacs redisplay, does not.
   * The panel must rebuild for what it draws — refs and tags — and for nothing
   * else. Same code, both hosts.
   */
  test("typing prose does not rebuild the graph; typing a link does", () => {
    const root = document.createElement("div");
    root.className = "aaronnote-local-graph-panel is-collapsed";
    const toggleButton = document.createElement("button");
    const depthInput = input("range", false, "2");
    const depthLabel = document.createElement("span");
    const refsInput = input("checkbox", true);
    const backlinksInput = input("checkbox", true);
    const tagsInput = input("checkbox", true);
    const canvas = document.createElement("div");
    const status = document.createElement("div");
    document.body.append(root, toggleButton, canvas);

    const current = note({ id: "current", title: "Current" });
    const related = note({ id: "related", title: "Related" });
    const withTags = (tags: string): string => [
      "#+begin meta",
      "id: current",
      "title: Current",
      `tags: ${tags}`,
      "#+end meta",
      "",
      "Body",
    ].join("\n");
    let markdown = withTags("alpha");
    let builds = 0;

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
      createWorkspaceGraph: () => {
        builds += 1;
        return { center() {}, setActivity() {}, destroy() {} };
      },
    });

    try {
      panel.toggle();
      const afterOpen = builds;
      expect(afterOpen).toBeGreaterThan(0);

      // Ordinary prose: the length changes on every character, the graph does not.
      for (const word of ["one", "two", "three", "four", "five"]) {
        markdown += ` ${word}`;
        panel.update();
      }
      expect(builds).toBe(afterOpen);

      // A link is a real edge, so this one must rebuild.
      markdown += "\n\n[[related]]\n";
      panel.update();
      expect(builds).toBe(afterOpen + 1);

      // And a tag. Only the meta block declares roam tags, so this edits it
      // rather than writing a bare #hash in the body.
      const body = markdown.slice(markdown.indexOf("#+end meta"));
      markdown = withTags("alpha, gamma").replace(/#\+end meta[\s\S]*$/u, body);
      panel.update();
      expect(builds).toBe(afterOpen + 2);

      // Repeating the same document must not rebuild again.
      panel.update();
      expect(builds).toBe(afterOpen + 2);
    } finally {
      root.remove();
      toggleButton.remove();
      canvas.remove();
    }
  });

  test("replaces stale current-note DB edges with live Markdown edges", () => {
    const current = note({ id: "current", title: "Current", tags: ["stale"] });
    const fresh = note({ id: "fresh", title: "Fresh" });
    const stale = note({ id: "stale-note", title: "Stale" });
    const payload: GraphPayload = {
      indexVersion: 1,
      nodes: [
        { key: "current", title: "Current", tags: ["stale"] },
        { key: "fresh", title: "Fresh" },
        { key: "stale-note", title: "Stale" },
        { key: "tag:stale", title: "#stale", kind: "tag" },
      ],
      edges: [
        { source: "current", target: "stale-note", type: "ref" },
        { source: "current", target: "tag:stale", type: "tag" },
      ],
      meta: {},
    };
    const next = workspaceGraphWithCurrentMarkdown(
      payload,
      current,
      "#+begin meta\ntags: FreshTag\n#+end meta\n\n[[fresh]]\n",
      (ref) => ref === "fresh" ? fresh : ref === "stale-note" ? stale : undefined,
    );
    expect(next.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "current", target: "fresh", type: "ref" }),
      expect.objectContaining({ source: "current", target: "tag:freshtag", type: "tag" }),
    ]));
    expect(next.edges).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "current", target: "stale-note" }),
      expect.objectContaining({ source: "current", target: "tag:stale" }),
    ]));
    expect(next.nodes.find((node) => node.key === "current")?.tags).toEqual(["FreshTag"]);
  });

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
    let rendered!: GraphPayload;
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
      createWorkspaceGraph: (options: WorkspaceGraphOptions) => {
        rendered = options.payload;
        return { center() {}, setActivity() {}, destroy() {} };
      },
    });

    try {
      panel.toggle();
      const labels = rendered.nodes.map((node) => node.title || "");
      expect(labels).toEqual(expect.arrayContaining(["Current", "Related", "#alpha", "#beta", "#gamma"]));
      expect(labels).not.toContain("#old-index-tag");
      expect(labels).not.toContain("#inline-index-tag");
      expect(labels).not.toContain("#inline-anchor");
      expect(labels).not.toContain("#hash-anchor");
      expect(rendered.edges.filter((edge) => edge.type === "tag").length).toBeGreaterThanOrEqual(4);
    } finally {
      panel.collapse();
      root.remove();
      toggleButton.remove();
      canvas.remove();
    }
  });
});
