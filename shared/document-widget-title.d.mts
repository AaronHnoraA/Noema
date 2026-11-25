import type { AttrMap } from "./layout-attrs.mjs";

export function hasDocumentWidgetOptions(kind: string): boolean;
export function splitDocumentWidgetTitle(kind: string, source: string): { title: string; attrs: AttrMap };
