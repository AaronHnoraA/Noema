import { type WorldPoint } from "../../coords/points.js";
import type { EvaluateOptions } from "../../semantic/types.js";
import { type EditParseOptions } from "../parse-options.js";
import type { EditActionResult } from "../actions.js";
export type PositionNodeRelativeToAction = {
    kind: "positionNodeRelativeTo";
    nodeId: string;
    targetNodeName: string;
    targetNodeSourceId: string;
};
export type ConvertNodePositionToAbsoluteAction = {
    kind: "convertNodePositionToAbsolute";
    nodeId: string;
};
export type PositionNodeRelativeToPreview = {
    direction: string;
    currentAnchor: WorldPoint;
    targetAnchor: WorldPoint;
};
export type PositionNodeRelativeToPreflight = {
    result: EditActionResult;
    preview: PositionNodeRelativeToPreview | null;
};
export declare function applyPositionNodeRelativeToAction(source: string, action: PositionNodeRelativeToAction, evaluateOptions: EvaluateOptions | undefined, parseOptions: EditParseOptions): EditActionResult;
export declare function preflightPositionNodeRelativeToAction(source: string, action: PositionNodeRelativeToAction, evaluateOptions: EvaluateOptions | undefined, parseOptions: EditParseOptions): PositionNodeRelativeToPreflight;
export declare function applyConvertNodePositionToAbsoluteAction(source: string, action: ConvertNodePositionToAbsoluteAction, evaluateOptions: EvaluateOptions | undefined, parseOptions: EditParseOptions): EditActionResult;
