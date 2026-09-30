import type { PathItem, PathOptionItem, Span } from "../../ast/types.js";
import type { SemanticContext } from "../context.js";
import type { DiagnosticPushFn, PlacementSegment } from "../path/types.js";
import type { WorldPoint } from "../../coords/points.js";
export declare function resolveNodeTargetPoint(item: PathItem & {
    kind: "Node";
    atRaw?: string;
    atSpan?: Span;
    atRelativePrefix?: "+" | "++";
}, context: SemanticContext, handleSourceId: string, span: {
    from: number;
    to: number;
}, pushDiagnostic: DiagnosticPushFn, options: PathOptionItem["options"] | undefined, segment: PlacementSegment | null, defaultPoint?: WorldPoint, opts?: {
    allowImplicitOriginHandle?: boolean;
    explicitAtSyntax?: boolean;
}): WorldPoint;
export declare function resolveNodePositionFraction(options: PathOptionItem["options"] | undefined): number | null;
export declare function pointAtPlacementSegment(segment: PlacementSegment, t: number): WorldPoint;
