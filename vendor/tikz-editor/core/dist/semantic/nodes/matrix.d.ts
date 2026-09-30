import type { NodeItem, PathStatement, Span } from "../../ast/types.js";
import type { OptionListAst } from "../../options/types.js";
import type { SemanticContext } from "../context.js";
import type { NodePositioningResolution } from "../path/node-positioning.js";
import type { DiagnosticPushFn, FeatureMarkFn } from "../path/types.js";
import { type StyleChainEntry } from "../style-chain.js";
import type { WorldPoint } from "../../coords/points.js";
import type { ResolvedStyle, SceneElement } from "../types.js";
import type { NodeShape } from "./types.js";
type MatrixSpacingSpec = {
    gap: number;
    betweenOrigins: boolean;
};
export type MatrixMode = {
    enabled: boolean;
    matrixOfNodes: boolean;
    matrixKind: "plain" | "nodes" | "math-nodes";
    textMode: "text" | "math";
    includeEmptyCells: boolean;
    cellSeparator: string;
    rowSep: MatrixSpacingSpec;
    columnSep: MatrixSpacingSpec;
    nodesOption?: OptionListAst;
    matrixAnchor?: string;
};
export type MatrixParsedRowsForEdit = {
    rows: Array<{
        cells: Array<{
            raw: string;
            span: Span;
        }>;
    }>;
};
export type MatrixNodeEvaluation = {
    behindElements: SceneElement[];
    frontElements: SceneElement[];
};
type MatrixNodeEvaluator = (item: NodeItem, defaultTargetWorldPoint: WorldPoint) => MatrixNodeEvaluation;
export type EvaluateMatrixNodeParams = {
    item: NodeItem;
    statement: PathStatement;
    context: SemanticContext;
    style: ResolvedStyle;
    markFeature: FeatureMarkFn;
    pushDiagnostic: DiagnosticPushFn;
    forcedName?: string;
    matrixMode: MatrixMode;
    nodeShape: NodeShape;
    nodeStyle: ResolvedStyle;
    nodeStyleChain: StyleChainEntry[];
    effectiveNodeOptions: OptionListAst | undefined;
    effectiveNodeLocalOptions: OptionListAst | undefined;
    inheritedTransformScale: number;
    resolvedPositioning: NodePositioningResolution;
    fallbackAnchor: string;
    evaluateNestedNode: MatrixNodeEvaluator;
};
export declare function evaluateMatrixNodeItem(params: EvaluateMatrixNodeParams): MatrixNodeEvaluation;
export type MatrixCellEditTarget = {
    row: number;
    column: number;
    textMode: "text" | "math";
    cellSpan: Span;
    textSpan: Span;
    optionSpan?: Span;
};
export declare function resolveMatrixCellEditTarget(matrixText: string, matrixTextSpan: Span, mode: MatrixMode, row: number, column: number): MatrixCellEditTarget | null;
export declare function resolveMatrixMode(options: OptionListAst | undefined): MatrixMode;
export declare function parseMatrixRowsForEdit(input: string, cellSeparator: string, baseOffset: number): MatrixParsedRowsForEdit;
export {};
