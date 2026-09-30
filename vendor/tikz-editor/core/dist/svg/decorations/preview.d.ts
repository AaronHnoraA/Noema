import type { SceneElement, SceneFigure } from "../../semantic/types.js";
export declare function renderPathMorphingDecorationPreviewSvg(decorationName: string, lineWidth: number): string;
export declare function clearPathMorphingDecorationPreviewCache(): void;
export declare function computeDecorationPreviewBounds(elements: readonly SceneElement[]): SceneFigure["bounds"] | undefined;
