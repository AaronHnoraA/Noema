import type { WorldTransform } from "../../coords/transforms.js";
import { type WorldPoint } from "../../coords/points.js";
import type { ScenePathCommand } from "../types.js";
import type { PlacementSegment } from "./types.js";
export type SvgPathParseResult = {
    commands: ScenePathCommand[];
    endPoint: WorldPoint;
    subpathStartPoint: WorldPoint | null;
    lastSegment: PlacementSegment | null;
    diagnostics: string[];
};
export declare function parseSvgPathOperation(args: {
    payloadRaw: string;
    transform: WorldTransform;
    startPoint: WorldPoint;
    subpathStartPoint: WorldPoint | null;
}): SvgPathParseResult;
