import type { EditActionResultLike } from "../result-types.js";
import type { EvaluateOptions } from "../../semantic/types.js";
import type { WorldPoint } from "../../coords/points.js";
import { type DragFormatPrecision } from "../format.js";
import { type EditParseOptions } from "../parse-options.js";
type ResizeRole = "top-left" | "top-right" | "bottom-left" | "bottom-right" | "top" | "bottom" | "left" | "right";
export type ResizeElementAction = {
    elementId: string;
    role: ResizeRole;
    newWorld: WorldPoint;
    preserveAspect?: boolean;
    preserveAspectRatio?: number;
    formatPrecision?: DragFormatPrecision;
    referenceBounds?: {
        minX: number;
        minY: number;
        maxX: number;
        maxY: number;
    };
    referenceScopeTransform?: {
        xscale: number;
        yscale: number;
        xshift: number;
        yshift: number;
    };
};
export declare function applyResizeElementAction(source: string, action: ResizeElementAction, evaluateOptions: EvaluateOptions | undefined, parseOptions?: EditParseOptions): EditActionResultLike;
export {};
