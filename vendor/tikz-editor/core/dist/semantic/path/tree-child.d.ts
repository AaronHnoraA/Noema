import type { WorldPoint } from "../../coords/points.js";
import type { EdgeFromParentOperationItem, PathItem } from "../../ast/types.js";
export declare function hasFollowingChildOperation(items: PathItem[], startIndex: number): boolean;
export declare function hasNamedTreeRootNode(items: PathItem[]): boolean;
export declare function splitChildBodyAndTrailingEdgeFromParent(items: PathItem[]): {
    body: PathItem[];
    trailingEdge: EdgeFromParentOperationItem | null;
    trailingCoordinateOperations: Array<Extract<PathItem, {
        kind: "CoordinateOperation";
    }>>;
};
export declare function formatPointCoordinateRaw(point: WorldPoint): string;
export declare function sanitizeGeneratedNodeName(raw: string): string;
