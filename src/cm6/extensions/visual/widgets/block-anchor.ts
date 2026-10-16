/**
 * Noema block-identity indicator. Ordinary Markdown blocks carry an explicit
 * trailing `{#id}` only after the user gives that block an identity (reference,
 * embed, attribute view, ...). Org environments already render identities in
 * block-extras.ts, so this extension deliberately skips `#+begin` lines.
 *
 * This is a viewport-local Visual-mode projection. It never changes source;
 * touching the anchor with the selection reveals the raw `{#id}` text.
 */

import { WidgetType } from "@codemirror/view";
import { BLOCK_ANCHOR_SOURCE, shortBlockId } from "../../../../../shared/block-identity.mjs";
import { inlineConstruct } from "../constructs/index.ts";

const BLOCK_ANCHOR_RE = new RegExp(BLOCK_ANCHOR_SOURCE, "g");
const MAX_VIEWPORT_BADGES = 2_000;

class BlockAnchorWidget extends WidgetType {
  readonly id: string;

  constructor(id: string) {
    super();
    this.id = id;
  }

  eq(other: BlockAnchorWidget): boolean { return this.id === other.id; }

  toDOM(): HTMLElement {
    const badge = document.createElement("span");
    badge.className = "cm-noema-block-id";
    badge.textContent = `#${shortBlockId(this.id)}`;
    badge.title = this.id;
    badge.setAttribute("role", "button");
    badge.setAttribute("aria-label", `Copy block ID ${this.id}`);
    badge.addEventListener("mousedown", (event) => { event.preventDefault(); event.stopPropagation(); });
    badge.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      navigator.clipboard?.writeText(this.id).then(() => {
        badge.classList.add("cm-noema-block-id-copied");
        window.setTimeout(() => badge.classList.remove("cm-noema-block-id-copied"), 600);
      }).catch(() => {});
    });
    return badge;
  }

  ignoreEvent(): boolean { return true; }
}

export const blockAnchorExtension = inlineConstruct({
  kind: "block-anchor",
  reveal: "edge",
  maxPerViewport: MAX_VIEWPORT_BADGES,
  *match(line) {
    if (!line.text.includes("{#") || /^\s*#\+begin\b/i.test(line.text)) return;
    BLOCK_ANCHOR_RE.lastIndex = 0;
    for (let match = BLOCK_ANCHOR_RE.exec(line.text); match; match = BLOCK_ANCHOR_RE.exec(line.text)) {
      const from = line.from + match.index;
      const id = match[1]!;
      yield { from, to: from + match[0].length, widget: () => new BlockAnchorWidget(id) };
    }
  },
});
