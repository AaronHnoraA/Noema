import { type WorldPoint } from "../../coords/points.js";
import type { PlacementSegment } from "./types.js";
import type { ScenePathCommand } from "../types.js";
export declare function appendPathPoint(commands: ScenePathCommand[], operator: "--" | "-|" | "|-" | null, current: WorldPoint | null, next: WorldPoint, previousSegmentRoundedCorners: number | null, currentSegmentRoundedCorners: number | null): {
    segment: PlacementSegment | null;
    nextRoundedCorners: number | null;
};
export declare function roundClosedPathStartCorner(commands: ScenePathCommand[], closingFrom: WorldPoint, start: WorldPoint, cornerRoundedCorners: number | null): void;
