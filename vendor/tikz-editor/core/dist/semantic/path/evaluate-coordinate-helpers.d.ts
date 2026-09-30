import type { WorldPoint } from "../../coords/points.js";
import type { CoordinateItem } from "../../ast/types.js";
import type { EvaluatedCoordinate } from "../coords/evaluate.js";
import type { PlacementSegment } from "./types.js";
export declare function evaluateTurnCoordinate(item: CoordinateItem, currentPoint: WorldPoint | null, transform: {
    a: number;
    b: number;
    c: number;
    d: number;
    e: number;
    f: number;
}, lastPlacementSegment: PlacementSegment | null): EvaluatedCoordinate | null;
export declare function resolveDefaultGridStep(transform: {
    a: number;
    b: number;
    c: number;
    d: number;
}, axis: "x" | "y"): number;
