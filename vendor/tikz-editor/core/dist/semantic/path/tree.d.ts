import type { WorldPoint } from "../../coords/points.js";
import type { ChildOperationItem, PathItem, Span } from "../../ast/types.js";
import type { ProvenanceOptionList, SemanticContextFrame } from "../context.js";
import type { SemanticContext } from "../context.js";
export type TreeChildCluster = {
    children: ChildOperationItem[];
    consumed: number;
};
export type TreePreparedRoot = {
    body: PathItem[];
    rootNameRaw: string;
    rootSpan: Span;
};
export type TreeDeferredDiagnostic = {
    code: string;
    message: string;
    span: Span;
};
export declare function collectTreeChildCluster(items: PathItem[], startIndex: number): TreeChildCluster;
export declare function makeTreeAutoName(parentNameRaw: string | null, statementId: string, childItemId: string, childIndex: number, level: number): string;
export declare function prepareChildBodyWithRoot(child: ChildOperationItem, generatedRootName: string): TreePreparedRoot;
export declare function resolveTreeLevelStyleLayers(frame: SemanticContextFrame, level: number): ProvenanceOptionList[];
export declare function computeTreeChildOrigin(parentOrigin: WorldPoint, levelDistancePt: number, siblingDistancePt: number, childIndexOneBased: number, childCount: number, growDirectionDegrees: number, growReverse: boolean): WorldPoint;
export declare function resolveNamedTreeAnchorPoint(context: SemanticContext, nameRaw: string, anchorRaw: string, fallbackPoint: WorldPoint, towardPoint: WorldPoint): WorldPoint;
export declare function collectDeferredTreeHookDiagnostics(frame: Pick<SemanticContextFrame, "treeDeferredGrowthFunction" | "treeDeferredEdgeFromParentPath" | "treeDeferredEdgeFromParentMacro">, span: Span): TreeDeferredDiagnostic[];
