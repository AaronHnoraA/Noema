/**
 * Sanitizing a rendered diagram.
 *
 * Mermaid puts a label's HTML inside a `<foreignObject>`, which an SVG-profile
 * sanitizer would strip. That HTML is sanitized on its own and carried through
 * the SVG pass in an inert attribute, then put back by whichever surface is
 * about to show it: a live widget hydrates the DOM, a static export hydrates
 * the markup.
 *
 * Shared by the editor's renderer and the HTML export so both apply one policy.
 */

import DOMPurify from "dompurify";

const FOREIGN_OBJECT_HTML_ATTR = "data-noema-foreign-html";

function sanitizeForeignObjectHtml(html: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  template.content.querySelectorAll("script, iframe, object, embed, link, meta, base, style").forEach((node) => node.remove());
  template.content.querySelectorAll("*").forEach((node) => {
    Array.from(node.attributes).forEach((attribute) => {
      if (/^on/i.test(attribute.name) || attribute.name.toLowerCase() === "srcdoc") {
        node.removeAttribute(attribute.name);
      }
    });
  });
  return DOMPurify.sanitize(template.innerHTML, {
    USE_PROFILES: { html: true, mathMl: true },
    FORBID_TAGS: ["script", "iframe", "object", "embed", "link", "meta", "base", "style"],
    FORBID_ATTR: ["srcdoc"],
  });
}

export function sanitizeDiagramSvg(svg: string): string {
  const template = document.createElement("template");
  template.innerHTML = svg;
  template.content.querySelectorAll<SVGForeignObjectElement>("foreignObject").forEach((foreignObject) => {
    const safeHtml = sanitizeForeignObjectHtml(foreignObject.innerHTML);
    foreignObject.replaceChildren();
    foreignObject.setAttribute(FOREIGN_OBJECT_HTML_ATTR, safeHtml);
  });

  return DOMPurify.sanitize(template.innerHTML, {
    USE_PROFILES: { svg: true, svgFilters: true, mathMl: true },
    // foreignObject is needed for Mermaid mindmap labels. Its HTML was sanitized
    // separately and is carried through this SVG-only pass in an inert data attr.
    ADD_TAGS: ["foreignObject"],
    ADD_ATTR: ["href", "xlink:href", "target", "title", "requiredExtensions", "xmlns", "style"],
  });
}

/**
 * Put the stashed label HTML back as real markup. The live editor hydrates the
 * DOM instead; a standalone HTML file has no later chance, so an export that
 * skipped this would publish a diagram whose every label is missing.
 */
export function hydrateDiagramForeignObjectMarkup(svg: string): string {
  const template = document.createElement("template");
  template.innerHTML = String(svg || "");
  template.content.querySelectorAll(`foreignObject[${FOREIGN_OBJECT_HTML_ATTR}]`).forEach((foreignObject) => {
    foreignObject.innerHTML = foreignObject.getAttribute(FOREIGN_OBJECT_HTML_ATTR) ?? "";
    foreignObject.removeAttribute(FOREIGN_OBJECT_HTML_ATTR);
  });
  return template.innerHTML;
}

export { FOREIGN_OBJECT_HTML_ATTR };
