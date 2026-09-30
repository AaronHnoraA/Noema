import type { NodeItem, PathStatement } from "../../ast/types.js";
import { type SemanticContext } from "../context.js";
import type { DiagnosticPushFn, FeatureMarkFn, PlacementSegment } from "../path/types.js";
import type { WorldPoint } from "../../coords/points.js";
import type { ResolvedStyle, SceneElement } from "../types.js";
import { type StyleChainEntry } from "../style-chain.js";
export type NodeAnchorExtents = {
    left: number;
    right: number;
    up: number;
    down: number;
    halfWidth: number;
    halfHeight: number;
};
export declare function measureNodeAnchorExtents(item: NodeItem, statement: PathStatement, context: SemanticContext, style: ResolvedStyle, defaultPositionFraction?: number): NodeAnchorExtents;
export declare function evaluateNodeItem(item: NodeItem, statement: PathStatement, context: SemanticContext, style: ResolvedStyle, markFeature: FeatureMarkFn, pushDiagnostic: DiagnosticPushFn, segment: PlacementSegment | null, forcedName?: string, defaultPositionFraction?: number, defaultTargetWorldPoint?: WorldPoint, baseStyleChain?: StyleChainEntry[], placementOptions?: {
    allowImplicitOriginHandle?: boolean;
    explicitAtSyntax?: boolean;
    textMode?: "text" | "math";
}): {
    behindElements: SceneElement[];
    frontElements: SceneElement[];
};
export { applyNameScope, maybeResolveNamedCoordinateBorderPoint, maybeResolveNamedCoordinateBorderPointFromRaw, maybeResolveNamedCoordinateBorderPointFromRawAlongAngle, maybeResolveTrailingCoordinateFromNodeName, shouldCaptureStandaloneNodeNameCoordinate } from "./named-coordinates.js";
