/**
 * Noema block-reference live-preview: `((<UUIDv7> "anchor text"))` or bare
 * `((<UUIDv7>))`. The timestamp-shaped IDs produced during the SiYuan-kernel
 * spike remain readable, but new identities follow Noema's UUIDv7 contract.
 * Renders as a link-styled chip; clicking
 * dispatches `aaronnote:open-block-ref` (bubbles, cancelable) on the widget
 * element the same way `editor-cm6.ts` dispatches `aaronnote:open-url` —
 * this module stays host-agnostic. The production and lab host adapters
 * resolve that event through the shared kernel block index.
 *
 * Deliberately does not mark refs as valid/broken (unlike roam-link-status.ts):
 * the editor decoration layer has no injected validity snapshot, and doing a
 * request per visible chip would be an N+1 regression. Navigation performs a
 * real lookup on demand instead.
 */

import { WidgetType } from "@codemirror/view";
import { BLOCK_REFERENCE_ID_SOURCE, shortBlockId } from "../../../../../shared/block-identity.mjs";
import { inlineConstruct } from "../constructs/index.ts";

const BLOCK_REF_RE = new RegExp(
  String.raw`\(\((${BLOCK_REFERENCE_ID_SOURCE})(?:\s+(["'])((?:\\.|(?!\2)[\s\S])*)\2)?\)\)`,
  "g",
);
const MAX_VIEWPORT_REFS = 2_000;

function unescapeTitle(raw: string): string {
  return raw.replace(/\\(.)/g, "$1");
}

class BlockRefWidget extends WidgetType {
  readonly id: string;
  readonly label: string;

  constructor(id: string, text: string | undefined) {
    super();
    this.id = id;
    this.label = text ? unescapeTitle(text) : `#${shortBlockId(id)}`;
  }

  eq(other: BlockRefWidget): boolean { return this.id === other.id && this.label === other.label; }

  toDOM(): HTMLElement {
    const link = document.createElement("span");
    link.className = "cm-block-ref";
    link.textContent = this.label;
    link.title = this.id;
    link.setAttribute("role", "link");
    link.setAttribute("aria-label", `Open block ${this.id}`);
    link.addEventListener("mousedown", (event) => { event.preventDefault(); event.stopPropagation(); });
    link.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      link.dispatchEvent(new CustomEvent("aaronnote:open-block-ref", {
        bubbles: true,
        cancelable: true,
        detail: { id: this.id, text: this.label },
      }));
    });
    return link;
  }

  ignoreEvent(): boolean { return true; }
}

export const blockRefExtension = inlineConstruct({
  kind: "block-ref",
  reveal: "edge",
  maxPerViewport: MAX_VIEWPORT_REFS,
  *match(line) {
    if (!line.text.includes("((")) return;
    BLOCK_REF_RE.lastIndex = 0;
    for (let match = BLOCK_REF_RE.exec(line.text); match; match = BLOCK_REF_RE.exec(line.text)) {
      const from = line.from + match.index;
      const id = match[1]!;
      const title = match[3];
      yield { from, to: from + match[0].length, widget: () => new BlockRefWidget(id, title) };
    }
  },
});
