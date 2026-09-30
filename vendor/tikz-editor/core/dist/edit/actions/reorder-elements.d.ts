import type { EditActionResultLike } from "../result-types.js";
import type { Span } from "../../ast/types.js";
import { type StatementRef } from "../statement-ops.js";
import type { EditParseOptions } from "../parse-options.js";
export type ReorderDirection = "sendToBack" | "sendBackward" | "bringForward" | "bringToFront";
export type ReorderReplacement = {
    span: Span;
    text: string;
    newSpansById: Map<string, Span>;
};
export declare function applyReorderElementsAction(source: string, elementIds: readonly string[], direction: ReorderDirection, parseOptions?: EditParseOptions): EditActionResultLike;
export declare function buildParentReorderReplacement(source: string, parentRefs: readonly StatementRef[], orderedIds: readonly string[]): ReorderReplacement | null;
