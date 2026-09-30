import type { WorldPoint } from "../../coords/points.js";
import type { PathOptionItem } from "../../ast/types.js";
import type { DiagnosticPushFn, ArcParameters, PlacementSegment } from "./types.js";
import type { MacroBinding, MacroExpansionTraceEvent } from "../../macros/index.js";
import type { ResolvedStyle, ScenePathCommand } from "../types.js";
export declare function extractArcParameters(item: PathOptionItem, pushDiagnostic: DiagnosticPushFn, style: ResolvedStyle, macroBindings?: ReadonlyMap<string, MacroBinding>, macroTraceCollector?: MacroExpansionTraceEvent[]): ArcParameters | null;
export declare function parseArcShorthand(raw: string): ArcParameters | null;
export declare function appendArcCommand(commands: ScenePathCommand[], from: WorldPoint, params: ArcParameters, transform?: {
    a: number;
    b: number;
    c: number;
    d: number;
}): {
    endpoint: WorldPoint;
    segment: PlacementSegment;
};
