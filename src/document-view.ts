import { approvedEdiffMarkdown } from "../shared/ediff-source.mjs";
import { stripCommentAnchors } from "../shared/comment-anchors.mjs";
import { shortHash } from "./cm6/extensions/visual/widgets/measured-observer.ts";

export function documentViewSourceKey(kind: string, title: string, body: string): string {
  const visible = stripCommentAnchors(approvedEdiffMarkdown(body)).replace(/\s+/g, " ").trim();
  return `${kind}:${shortHash(stripCommentAnchors(title).trim())}:${shortHash(visible)}`;
}

export function forEachDocumentViewTree(root: ParentNode, visit: (tree: ParentNode) => void): void {
  visit(root);
  for (const template of root.querySelectorAll<HTMLTemplateElement>("template[data-view-content]")) {
    forEachDocumentViewTree(template.content, visit);
  }
}

export function numberDocumentViews(container: ParentNode, counts = new Map<string, number>()): void {
  for (const node of container.querySelectorAll<HTMLElement>("[data-view-source], template[data-view-content]")) {
    if (node instanceof HTMLTemplateElement) {
      numberDocumentViews(node.content, counts);
    } else {
      const key = node.dataset.viewSource!;
      const index = counts.get(key) ?? 0;
      node.dataset.viewOccurrence = String(index);
      counts.set(key, index + 1);
    }
  }
}
