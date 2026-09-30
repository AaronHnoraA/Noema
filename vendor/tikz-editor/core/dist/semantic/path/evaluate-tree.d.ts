import type { WorldPoint } from "../../coords/points.js";
import type { PathStatement } from "../../ast/types.js";
import { type SemanticContext } from "../context.js";
import type { ResolvedStyle, SceneElement } from "../types.js";
import { type parseStyleValueAsOptionList } from "../style/resolve.js";
import type { DiagnosticPushFn, FeatureMarkFn } from "./types.js";
export type TreeParentCandidate = {
    nameRaw: string | null;
    point: WorldPoint;
    span: {
        from: number;
        to: number;
    };
} | null;
export declare function handleChildOperationCluster(params: {
    statement: PathStatement;
    index: number;
    treeParentCandidate: TreeParentCandidate;
    treeFrameState: SemanticContext["stack"][number];
    context: SemanticContext;
    defaultPathOrigin: WorldPoint;
    drawEdgeOptions: ReturnType<typeof parseStyleValueAsOptionList>;
    edgeFromParentStyleOptions: ReturnType<typeof parseStyleValueAsOptionList>;
    markFeature: FeatureMarkFn;
    pushDiagnostic: DiagnosticPushFn;
    emittedTreeHookDiagnostics: Set<string>;
    evaluatePathStatement: (statement: PathStatement, context: SemanticContext, style: ResolvedStyle, markFeature: FeatureMarkFn, pushDiagnostic: DiagnosticPushFn, options?: {
        honorInitialCurrentPoint?: boolean;
    }) => SceneElement[];
    frontNodeElements: SceneElement[];
    evaluateRawCoordinateWorld: (rawCoordinate: string) => WorldPoint | null;
}): {
    consumed: number;
    treeParentCandidate: TreeParentCandidate;
};
