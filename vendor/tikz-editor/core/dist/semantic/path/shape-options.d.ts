import type { PathOptionItem } from "../../ast/types.js";
import type { MacroBinding, MacroExpansionTraceEvent } from "../../macros/index.js";
import type { DiagnosticPushFn } from "./types.js";
type ParsedLengthWithTransform = {
    value: number;
    applyFrameTransform: boolean;
};
export declare function extractEllipseRadii(item: PathOptionItem, pushDiagnostic: DiagnosticPushFn, macroBindings?: ReadonlyMap<string, MacroBinding>, macroTraceCollector?: MacroExpansionTraceEvent[]): {
    rx: ParsedLengthWithTransform;
    ry: ParsedLengthWithTransform;
} | null;
export declare function extractCircleShapeOptions(item: PathOptionItem, macroBindings?: ReadonlyMap<string, MacroBinding>, macroTraceCollector?: MacroExpansionTraceEvent[]): {
    radius?: ParsedLengthWithTransform;
    rx?: ParsedLengthWithTransform;
    ry?: ParsedLengthWithTransform;
    rotation?: number;
};
export declare function extractRoundedCorners(options: PathOptionItem["options"], current: number | null): number | null | undefined;
export {};
