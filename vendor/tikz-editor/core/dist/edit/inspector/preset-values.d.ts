import type { ResolvedPattern } from "../../semantic/types.js";
import type { DashStylePresetId, FillPatternPresetId, FillShadingPresetId, LineCapPresetId, LineJoinPresetId } from "./presets.js";
export declare function fillShadingPresetFromStyleName(raw: string): FillShadingPresetId;
export declare function fillPatternPresetFromResolvedPattern(pattern: ResolvedPattern | null): FillPatternPresetId;
export declare function fillPatternPresetFromRaw(raw: string): FillPatternPresetId;
export declare function lineWidthPresetLabel(value: number): string | null;
export declare function dashStylePresetFromStyle(dashArray: number[] | null, lineWidth: number): DashStylePresetId;
export declare function lineCapPresetFromStyle(value: "butt" | "round" | "square"): LineCapPresetId;
export declare function lineJoinPresetFromStyle(value: "miter" | "round" | "bevel"): LineJoinPresetId;
