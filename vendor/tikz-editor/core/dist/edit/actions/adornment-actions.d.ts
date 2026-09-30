import type { EditActionResultLike } from "../result-types.js";
import type { WorldPoint } from "../../coords/points.js";
import type { EditParseOptions } from "../parse-options.js";
import type { DragFormatPrecision } from "../format.js";
export type MoveAdornmentAction = {
    targetId: string;
    ownerPoint: WorldPoint;
    newWorld: WorldPoint;
    angleRaw?: string;
    distancePt?: number;
    formatPrecision?: DragFormatPrecision;
};
export type AddNodeAdornmentAction = {
    nodeId: string;
    adornmentKind: "label" | "pin";
    angle: string;
    text: string;
};
export declare function applyDuplicateAdornmentAction(source: string, targetId: string, parseOptions?: EditParseOptions): EditActionResultLike;
export declare function applyMoveAdornmentAction(source: string, action: MoveAdornmentAction, parseOptions?: EditParseOptions): EditActionResultLike;
export declare function applyAddNodeAdornmentAction(source: string, action: AddNodeAdornmentAction, parseOptions?: EditParseOptions): EditActionResultLike;
