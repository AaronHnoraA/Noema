import type { EditActionResultLike } from "../result-types.js";
import type { WorldPoint } from "../../coords/points.js";
import type { EditHandle } from "../../semantic/types.js";
import { type DragFormatPrecision } from "../format.js";
import { type AlignMode, type DistributeAxis } from "../arrange.js";
import { type EditParseOptions } from "../parse-options.js";
export type AlignElementsAction = {
    elementIds: string[];
    mode: AlignMode;
};
export type DistributeElementsAction = {
    elementIds: string[];
    axis: DistributeAxis;
};
export declare function applyMoveElementsAction(source: string, editHandles: EditHandle[], elementIds: readonly string[], delta: WorldPoint, formatPrecision: DragFormatPrecision | undefined, parseOptions?: EditParseOptions): EditActionResultLike;
export declare function applyAlignElementsAction(source: string, action: AlignElementsAction, parseOptions?: EditParseOptions): EditActionResultLike;
export declare function applyDistributeElementsAction(source: string, action: DistributeElementsAction, parseOptions?: EditParseOptions): EditActionResultLike;
