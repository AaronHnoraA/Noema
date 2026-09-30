import type { EditActionResultLike } from "../result-types.js";
import type { EvaluateOptions } from "../../semantic/types.js";
import { type EditParseOptions } from "../parse-options.js";
export type RotateElementAction = {
    kind: "rotateElement";
    elementId: string;
    targetId?: string;
    angleDeg: number;
    mode: "property" | "origin" | "center-pivot";
    baselineSource?: string;
};
export declare function applyRotateElementAction(currentSource: string, action: RotateElementAction, evaluateOptions: EvaluateOptions | undefined, parseOptions?: EditParseOptions): EditActionResultLike;
