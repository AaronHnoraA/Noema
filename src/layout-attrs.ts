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
  readLayoutAttrSuffix,
  readLayoutAttrsLine,
  readLayoutTrailingAttrs,
} from "../shared/layout-attrs.mjs";

export type { LayoutAlign, LayoutAttrs } from "../shared/layout-attrs.mjs";

export function applyLayoutAttrs(el: HTMLElement, kind: string, layout: LayoutAttrs): void {
  el.classList.add(...layoutClasses(kind, layout).split(/\s+/).filter(Boolean));
  el.dataset.noemaLayout = kind;
  el.dataset.noemaLayoutAlign = layout.align;
  el.dataset.noemaLayoutWrap = layout.wrap ? "true" : "false";
  if (layout.width) {
    el.style.setProperty("--noema-block-layout-width", layout.width);
    el.style.setProperty(`--noema-${kind}-width`, layout.width);
    el.style.setProperty(`--noema-${kind}-max-width`, "none");
    el.style.setProperty(`--noema-${kind}-max-height`, "none");
  }
  if (layout.height) {
    el.style.setProperty("--noema-block-layout-height", layout.height);
    el.style.setProperty(`--noema-${kind}-height`, layout.height);
    el.style.setProperty(`--noema-${kind}-max-height`, "none");
  }
}
