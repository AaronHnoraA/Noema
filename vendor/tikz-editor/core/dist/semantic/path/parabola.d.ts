import type { WorldPoint } from "../../coords/points.js";
import type { PathItem } from "../../ast/types.js";
import type { SemanticContext } from "../context.js";
import type { ScenePathCommand } from "../types.js";
export declare function parseParabolaFromItems(items: PathItem[], startIndex: number, context: SemanticContext): {
    consumedIndex: number;
    commands: ScenePathCommand[];
    endPoint: WorldPoint;
} | null;
