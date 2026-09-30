import type { EditActionResultLike } from "../result-types.js";
import type { WorldPoint } from "../../coords/points.js";
import type { EditHandle } from "../../semantic/types.js";
import { type EditParseOptions } from "../parse-options.js";
export type PasteStatementsAction = {
    snippets: string[];
    anchorElementId?: string;
    delta?: WorldPoint;
};
export type DuplicateElementsAction = {
    elementIds: string[];
    delta?: WorldPoint;
};
type MoveElementsResultLike = {
    kind: "success";
    newSource: string;
} | {
    kind: "partial";
    newSource: string;
    skippedHandles: string[];
    reason: string;
} | {
    kind: "unsupported";
    reason: string;
} | {
    kind: "error";
    message: string;
};
type PasteDuplicateDeps = {
    applyMoveElements: (source: string, editHandles: EditHandle[], elementIds: readonly string[], delta: WorldPoint, parseOptions?: EditParseOptions) => MoveElementsResultLike;
    normalizeElementIds: (elementIds: readonly string[]) => string[];
    uniqueStrings: (values: readonly string[]) => string[];
    defaultDuplicateOffsetPt: number;
};
export declare function applyPasteStatementsAction(source: string, action: PasteStatementsAction, deps: PasteDuplicateDeps, parseOptions?: EditParseOptions): EditActionResultLike;
export declare function applyDuplicateElementsAction(source: string, action: DuplicateElementsAction, deps: PasteDuplicateDeps, parseOptions?: EditParseOptions): EditActionResultLike;
export {};
