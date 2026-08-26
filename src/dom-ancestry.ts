export type DomBoundary = Element | null | undefined;

function startElement(node: Node | null | undefined): Element | null {
  if (!node || node.nodeType === Node.DOCUMENT_NODE) return null;
  return node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
}

function walkClosest(
  node: Node | null | undefined,
  matches: (element: Element) => boolean,
  boundary?: DomBoundary,
): HTMLElement | null {
  let element = startElement(node);
  while (element && element !== boundary) {
    if (matches(element)) return element as HTMLElement;
    element = element.parentElement;
  }
  return null;
}

function walkOutermost(
  node: Node | null | undefined,
  matches: (element: Element) => boolean,
  boundary?: DomBoundary,
): HTMLElement | null {
  let element = startElement(node);
  let result: HTMLElement | null = null;
  while (element && element !== boundary) {
    if (matches(element)) result = element as HTMLElement;
    element = element.parentElement;
  }
  return result;
}

export const closestByClassName = (node: Node | null | undefined, className: string, boundary?: DomBoundary) => (
  walkClosest(node, (element) => element.classList.contains(className), boundary)
);

export const closestByTag = (node: Node | null | undefined, tagName: string, boundary?: DomBoundary) => (
  walkClosest(node, (element) => element.tagName === tagName.toUpperCase(), boundary)
);

export const closestByAttribute = (
  node: Node | null | undefined,
  attribute: string,
  value?: string | null,
  boundary?: DomBoundary,
) => walkClosest(node, (element) => value == null
  ? element.hasAttribute(attribute)
  : (element.getAttribute(attribute) || "").split(/\s+/u).includes(value), boundary);

export const outermostByClassName = (node: Node | null | undefined, className: string, boundary?: DomBoundary) => (
  walkOutermost(node, (element) => element.classList.contains(className), boundary)
);

export const outermostByTag = (node: Node | null | undefined, tagName: string, boundary?: DomBoundary) => (
  walkOutermost(node, (element) => element.tagName === tagName.toUpperCase(), boundary)
);

export const outermostByAttribute = (
  node: Node | null | undefined,
  attribute: string,
  value?: string | null,
  boundary?: DomBoundary,
) => walkOutermost(node, (element) => value == null
  ? element.hasAttribute(attribute)
  : (element.getAttribute(attribute) || "").split(/\s+/u).includes(value), boundary);
