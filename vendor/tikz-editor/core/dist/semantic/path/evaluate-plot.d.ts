import type { WorldPoint } from "../../coords/points.js";
import type { PlotOperationItem } from "../../ast/types.js";
import type { MacroBinding } from "../../macros/index.js";
import type { SemanticContext } from "../context.js";
import { evaluateRawCoordinate } from "../coords/evaluate.js";
import type { ResolvedStyle, SceneElement } from "../types.js";
import type { StyleChainEntry } from "../style-chain.js";
import { type PlotSettings } from "./plot.js";
import type { DiagnosticPushFn, FeatureMarkFn, PlacementSegment } from "./types.js";
export declare function extractPlotCoordinateEntries(rawGroup: string): Array<{
    raw: string;
    relativePrefix?: "+" | "++";
}>;
export declare function evaluatePlotCoordinatePoints(params: {
    entries: Array<{
        raw: string;
        relativePrefix?: "+" | "++";
    }>;
    span: {
        from: number;
        to: number;
    };
    issuePrefix: string;
    currentPoint: WorldPoint | null;
    setCurrentPoint: (point: WorldPoint | null) => void;
    pushDiagnostic: DiagnosticPushFn;
    evaluateCoordinateRaw: (raw: string, relativePrefix?: "+" | "++") => {
        world: WorldPoint | null;
        diagnostics: string[];
        advancesCurrentPoint?: boolean;
    };
}): WorldPoint[];
export declare function emitPlotPath(params: {
    statementId: string;
    item: PlotOperationItem;
    points: WorldPoint[];
    settings: PlotSettings;
    connectFrom: WorldPoint | null;
    style: ResolvedStyle;
    styleChain: StyleChainEntry[];
    geometryElements: SceneElement[];
    markFeature: FeatureMarkFn;
    activeRoundedCorners: number | null;
    setCurrentPoint: (point: WorldPoint) => void;
    setPathStartPoint: (point: WorldPoint | null) => void;
}): {
    lastPlacementSegment: PlacementSegment | null;
    previousSegmentRoundedCorners: number | null;
};
export declare function buildPlotExpressionEntries(params: {
    context: SemanticContext;
    consumerStatementId: string;
    expressionRaw: string;
    settings: PlotSettings;
    macroBindings: Map<string, MacroBinding>;
}): Array<{
    raw: string;
}>;
export declare function defaultEvaluateCoordinateRaw(raw: string, contextCurrentPoint: WorldPoint | null, setContextCurrentPoint: (point: WorldPoint | null) => void, context: Parameters<typeof evaluateRawCoordinate>[1], relativePrefix?: "+" | "++"): ReturnType<typeof evaluateRawCoordinate>;
