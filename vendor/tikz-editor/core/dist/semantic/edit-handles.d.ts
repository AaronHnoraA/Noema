import type { Span } from "../ast/types.js";
import type { SemanticContext } from "./context.js";
import type { EvaluatedCoordinate } from "./coords/evaluate.js";
import type { EditHandle } from "./types.js";
export declare function createEditHandle(evaluated: EvaluatedCoordinate, sourceSpan: Span, sourceId: string, kind: "node-position" | "path-point" | "path-control", context: SemanticContext, opts?: {
    rewriteTargetHandleId?: string;
}): EditHandle | null;
