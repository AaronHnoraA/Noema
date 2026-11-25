import { readTrailingAttrs } from "./layout-attrs.mjs";

/** Separate the portable chart attributes from a title whose block anchor is already removed. */
export function splitChartTitle(source) {
  const suffix = /(?:^|\s)(\{[^{}]*\})$/u.exec(source);
  const attributes = suffix && readTrailingAttrs(source, source.length - suffix[1].length, { knownKeys: ["type", "accent"] });
  return attributes ? { title: source.slice(0, attributes.from).trimEnd(), attrs: attributes.attrs } : { title: source, attrs: {} };
}
