import type { LegacyPatternName } from "../../semantic/types.js";
type PreviewPatternPreset = LegacyPatternName | "Lines" | "Hatch" | "Dots" | "Stars";
export declare function renderFillPatternPreviewSvg(pattern: PreviewPatternPreset): string;
export declare function clearFillPatternPreviewCache(): void;
export {};
