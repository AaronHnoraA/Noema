import type { EditActionResultLike } from "../result-types.js";
import type { WorldPoint } from "../../coords/points.js";
import type { EditHandle } from "../../semantic/types.js";
import { type PathPointKind } from "../path-editing.js";
import type { EditParseOptions } from "../parse-options.js";
export type SplitPathAction = {
    elementId: string;
    handleId: string;
};
export type JoinPathsAction = {
    elementIds: [string, string];
};
export type ReversePathAction = {
    elementId: string;
};
export type ToggleClosedPathAction = {
    elementId: string;
    closed: boolean;
};
export type DeletePathPointAction = {
    elementId: string;
    handleId: string;
};
export type SetPathPointKindAction = {
    elementId: string;
    handleId: string;
    pointKind: PathPointKind;
};
export type AppendToPathAction = {
    elementId: string;
    end: "start" | "end";
    segmentSource: string;
};
export type InsertPathPointAction = {
    elementId: string;
    segmentIndex: number;
    point: WorldPoint;
};
type PathEditingDeps = {
    normalizeElementIds: (elementIds: readonly string[]) => string[];
};
export declare function applySplitPathAction(source: string, editHandles: EditHandle[], action: SplitPathAction, parseOptions?: EditParseOptions): EditActionResultLike;
export declare function applyJoinPathsAction(source: string, action: JoinPathsAction, deps: PathEditingDeps, parseOptions?: EditParseOptions): EditActionResultLike;
export declare function applyReversePathAction(source: string, action: ReversePathAction, parseOptions?: EditParseOptions): EditActionResultLike;
export declare function applyToggleClosedPathAction(source: string, action: ToggleClosedPathAction, parseOptions?: EditParseOptions): EditActionResultLike;
export declare function applyDeletePathPointAction(source: string, editHandles: EditHandle[], action: DeletePathPointAction, parseOptions?: EditParseOptions): EditActionResultLike;
export declare function applySetPathPointKindAction(source: string, editHandles: EditHandle[], action: SetPathPointKindAction, parseOptions?: EditParseOptions): EditActionResultLike;
export declare function applyAppendToPathAction(source: string, action: AppendToPathAction, parseOptions?: EditParseOptions): EditActionResultLike;
export declare function applyInsertPathPointAction(source: string, editHandles: EditHandle[], action: InsertPathPointAction, parseOptions?: EditParseOptions): EditActionResultLike;
export {};
