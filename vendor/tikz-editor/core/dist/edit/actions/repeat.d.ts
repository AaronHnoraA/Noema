import type { EditActionResultLike } from "../result-types.js";
import type { Span } from "../../ast/types.js";
import { type StatementRef, type StatementSnapshot } from "../statement-ops.js";
import { type EditParseOptions } from "../parse-options.js";
export type RepeatElementsAction = {
    elementIds: string[];
    columns: number;
    rows: number;
    horizontalStep: number;
    verticalStep: number;
};
export type RepeatSelectionEligibility = {
    kind: "eligible";
    snapshot: StatementSnapshot;
    refs: StatementRef[];
    replaceSpan: Span;
    indent: string;
} | {
    kind: "ineligible";
    reason: string;
};
export declare function getRepeatSelectionEligibility(source: string, elementIds: readonly string[], parseOptions?: EditParseOptions): RepeatSelectionEligibility;
export declare function applyRepeatElementsAction(source: string, action: RepeatElementsAction, parseOptions?: EditParseOptions): EditActionResultLike;
