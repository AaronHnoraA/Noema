import type { CoordinateForm, CoordinateItem } from "../../ast/types.js";
import { type SemanticContext } from "../context.js";
import type { FrameLocalPoint, WorldPoint } from "../../coords/points.js";
import type { FrameTransform } from "../../coords/transforms.js";
export type EvaluatedCoordinate = {
    kind: "transformed" | "world-only" | "invalid";
    world: WorldPoint | null;
    local?: FrameLocalPoint;
    frame?: FrameTransform;
    origin?: "named" | "calc" | "perpendicular" | "intersection" | "numeric-anchor";
    coordinateForm: CoordinateForm;
    relativePrefix?: "+" | "++";
    diagnostics: string[];
    advancesCurrentPoint: boolean;
};
export declare function evaluateCoordinate(item: CoordinateItem, context: SemanticContext): EvaluatedCoordinate;
export declare function evaluateRawCoordinate(raw: string, context: SemanticContext, relativePrefix?: CoordinateItem["relativePrefix"]): EvaluatedCoordinate;
