import type { Diagnostic } from "../diagnostics/types.js";
import type { OptionListAst } from "../options/types.js";
import { type WorldBounds } from "../coords/points.js";
import type { SemanticContext } from "./context.js";
import type { StyleSourceRef } from "./style-chain.js";
import type { SceneElement } from "./types.js";
export type BackgroundLayerOptionLayer = {
    rawOptions: OptionListAst[];
    sourceRef: StyleSourceRef;
};
export declare const BACKGROUND_CONFIG_KEYS: Set<string>;
export declare function collectBackgroundOptionEffects(context: SemanticContext, optionLists: readonly OptionListAst[], sourceRef: StyleSourceRef): boolean;
export declare function extractOnBackgroundLayerOptionLayers(optionLists: readonly OptionListAst[], sourceRef: StyleSourceRef): BackgroundLayerOptionLayer[];
export declare function makeEveryOnBackgroundLayerOptionLayer(sourceRef: StyleSourceRef): BackgroundLayerOptionLayer;
export declare function generateBackgroundHookElements(context: SemanticContext, contentBounds: WorldBounds | null, sourceFingerprint: string): {
    elements: SceneElement[];
    diagnostics: Diagnostic[];
};
