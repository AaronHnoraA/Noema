import { layoutClasses, type LayoutAttrs } from "../shared/layout-attrs.mjs";

export {
  LAYOUT_ATTR_KEYS,
  layoutClasses,
  layoutFromAttrs,
  layoutIsDefault,
  layoutLatexEnvironment,
  layoutLatexFigure,
  layoutLatexLength,
  layoutStyle,
  readLayoutAttrsLine,
  readLayoutTrailingAttrs,
} from "../shared/layout-attrs.mjs";

export type { LayoutAlign, LayoutAttrs } from "../shared/layout-attrs.mjs";

export function applyLayoutAttrs(el: HTMLElement, kind: string, layout: LayoutAttrs): void {
  el.classList.add(...layoutClasses(kind, layout).split(/\s+/).filter(Boolean));
  el.dataset.aaronnoteLayout = kind;
  el.dataset.aaronnoteLayoutAlign = layout.align;
  el.dataset.aaronnoteLayoutWrap = layout.wrap ? "true" : "false";
  if (layout.width) {
    el.style.setProperty(`--aaronnote-${kind}-width`, layout.width);
    el.style.setProperty(`--aaronnote-${kind}-max-width`, "none");
    el.style.setProperty(`--aaronnote-${kind}-max-height`, "none");
  }
  if (layout.height) {
    el.style.setProperty(`--aaronnote-${kind}-height`, layout.height);
    el.style.setProperty(`--aaronnote-${kind}-max-height`, "none");
  }
}
