import type { WorldPoint } from "../../coords/points.js";
import type { EdgeOperationItem, ToOperationItem, PathStatement } from "../../ast/types.js";
import { type SemanticContext } from "../context.js";
import type { ResolvedStyle, SceneElement, ScenePath } from "../types.js";
import type { DiagnosticPushFn, FeatureMarkFn, PlacementSegment } from "./types.js";
import type { StyleChainEntry } from "../style-chain.js";
export declare function applyToOperation(item: ToOperationItem, context: SemanticContext, statement: PathStatement, style: ResolvedStyle, styleChain: StyleChainEntry[], activePath: ScenePath | null, previousSegmentRoundedCorners: number | null, markFeature: FeatureMarkFn, pushDiagnostic: DiagnosticPushFn, startCoordinateRaw?: string | null): {
    activePath: ScenePath | null;
    segment: PlacementSegment | null;
    behindNodeElements: SceneElement[];
    frontNodeElements: SceneElement[];
    previousSegmentRoundedCorners?: number | null;
};
export declare function applyEdgeOperation(item: EdgeOperationItem, context: SemanticContext, statement: PathStatement, style: ResolvedStyle, styleChain: StyleChainEntry[], markFeature: FeatureMarkFn, pushDiagnostic: DiagnosticPushFn, startPoint: WorldPoint | null, startCoordinateRaw?: string | null): {
    activePath: ScenePath | null;
    segment: PlacementSegment | null;
    behindNodeElements: SceneElement[];
    frontNodeElements: SceneElement[];
    previousSegmentRoundedCorners?: number | null;
};
