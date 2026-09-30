import type { ParseTikzResult } from "../parser/index.js";
export type DocumentSymbols = {
    nodeNames: string[];
    styleNames: string[];
    coordinateNames: string[];
};
export type SymbolSnapshot = {
    parseResult: Pick<ParseTikzResult, "source" | "figure"> | null;
};
export declare function collectSymbols(snapshot: SymbolSnapshot): DocumentSymbols;
export { resolveDocHoverTarget } from "./doc-hover.js";
export type { DocHoverTarget, DocHoverTargetKind, ResolveDocHoverTargetInput } from "./doc-hover.js";
