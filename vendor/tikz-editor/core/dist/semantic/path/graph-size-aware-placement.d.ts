import type { WorldPoint } from "../../coords/points.js";
import type { NodeItem, PathStatement } from "../../ast/types.js";
import type { ResolvedStyle } from "../types.js";
import type { SemanticContext } from "../context.js";
import type { GraphPlacementHint } from "./graph.js";
export type RuntimeGraphNode = {
    syntheticNode: NodeItem;
    defaultPoint: WorldPoint;
    placementHint?: GraphPlacementHint;
    nodeIndex: number;
};
export declare function resolveSizeAwareGraphNodePoints(runtimeNodes: RuntimeGraphNode[], statement: PathStatement, context: SemanticContext, style: ResolvedStyle): Map<number, WorldPoint>;
