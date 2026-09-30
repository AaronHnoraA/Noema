import type { OptionEntry } from "../options/types.js";
import type { EditParseOptions } from "./parse-options.js";
import type { StyleLevel } from "./actions.js";
import type { SemanticPropertyId } from "./property-registry.js";
import { type PropertyTargetResolution } from "./property-target.js";
import type { ArrowTipPresetId, ArrowTipSide, DashStylePresetId, FillModePresetId, FillPatternMetaFamilyId, FillPatternMetaOptionKey, FillPatternMetaValues, FillPatternPresetId, FillShadingPresetId, LineCapPresetId, LineJoinPresetId, NodeFontFamilyId, NodeFontSizePresetId, NodeShapePresetId, PathMorphingDecorationPresetId, ShadowPresetId } from "./inspector/presets.js";
export type { DashStylePresetId, FillModePresetId, FillPatternPresetId, FillShadingPresetId, LineCapPresetId, LineJoinPresetId, NodeShapePresetId } from "./inspector/presets.js";
type PropertyTargetResolver = (targetId: string) => PropertyTargetResolution;
export type ArrowTipWriteContext = {
    startRaw: string;
    endRaw: string;
    clearKeys: string[];
};
export type PropertyWriteTargetLike = {
    mode: "setProperty";
    elementId: string;
    level: StyleLevel;
    key: string;
    propertyId?: SemanticPropertyId;
    writable: boolean;
    reason?: string;
};
export type ArrowTipWriteTarget = PropertyWriteTargetLike & {
    arrowContext: ArrowTipWriteContext;
};
export type ArrowTipSetPropertyMutation = {
    key: string;
    value: string;
    clearKeys: string[];
};
export type DashStyleSetPropertyMutation = {
    key: string;
    value: string;
    clearKeys: string[];
};
export type LineCapSetPropertyMutation = {
    key: string;
    value: string;
    clearKeys: string[];
};
export type LineJoinSetPropertyMutation = {
    key: string;
    value: string;
    clearKeys: string[];
};
export type LineWidthSetPropertyMutation = {
    key: string;
    value: string;
    clearKeys: string[];
};
export type PathMorphingDecorationSetPropertyMutation = {
    key: string;
    value: string;
    clearKeys: string[];
};
export type RoundedCornersSetPropertyMutation = {
    key: string;
    value: string;
    clearKeys: string[];
};
export type FillModeMutationContext = {
    fillColor: string | null;
    patternColor: string | null;
    shading: FillShadingPresetId;
    pattern: FillPatternPresetId;
};
export type FillModeSetPropertyMutation = {
    key: string;
    value: string;
    clearKeys: string[];
};
export type FillShadingSetPropertyMutation = {
    key: string;
    value: string;
    clearKeys: string[];
};
export type FillPatternSetPropertyMutation = {
    key: string;
    value: string;
    clearKeys: string[];
};
export type FillPatternOptionMutationContext = {
    family: FillPatternMetaFamilyId;
    values: FillPatternMetaValues;
};
export type FillPatternOptionSetPropertyMutation = {
    key: string;
    value: string;
    clearKeys: string[];
};
export type NodeShapeSetPropertyMutation = {
    key: string;
    value: string;
    clearKeys: string[];
};
export type NodeInnerSepSetPropertyMutation = {
    key: string;
    value: string;
    clearKeys: string[];
};
export type NodeMinimumDimensionKey = "minimum width" | "minimum height";
export type NodeMinimumDimensionsMutationContext = {
    minimumWidth: number;
    minimumHeight: number;
};
export type NodeMinimumDimensionSetPropertyMutation = {
    key: string;
    value: string;
    clearKeys: string[];
};
export type NodeFontMutationContext = {
    key: "font" | "node font";
    clearKeys: string[];
    fallbackCustomSizePt: number;
};
export type NodeFontSetPropertyMutation = {
    key: string;
    value: string;
    clearKeys: string[];
};
export type TransformInspectorKey = "xshift" | "yshift" | "xscale" | "yscale" | "rotate";
export type TransformRotateAroundContext = {
    pivotRaw: string;
    pivotLabel: string;
};
export type TransformInspectorValues = {
    xshift: number;
    yshift: number;
    xscale: number;
    yscale: number;
    rotate: number;
    rotateAround?: TransformRotateAroundContext | null;
};
export type TransformInspectorPresence = {
    shift: boolean;
    scale: boolean;
    xshift: boolean;
    yshift: boolean;
    xscale: boolean;
    yscale: boolean;
    rotate: boolean;
    rotateAround?: boolean;
};
export type TransformInspectorMutationContext = {
    values: TransformInspectorValues;
    presence?: TransformInspectorPresence;
};
export type TransformSetPropertyMutation = {
    key: string;
    value: string;
    clearKeys: string[];
};
export type ShadowMutationContext = {
    preset: ShadowPresetId;
    xshiftPt: number;
    yshiftPt: number;
    scale: number;
    opacity: number;
    color: string | null;
};
export type ShadowSetPropertyMutation = {
    key: string;
    value: string;
    clearKeys: string[];
};
export declare const DEFAULT_TRANSFORM_INSPECTOR_VALUES: TransformInspectorValues;
export declare const SHIFT_CLEAR_KEYS: readonly ["shift", "/tikz/shift"];
export declare const SCALE_CLEAR_KEYS: readonly ["scale", "/tikz/scale"];
export declare const ROTATE_CLEAR_KEYS: readonly ["/tikz/rotate", "rotate around", "/tikz/rotate around"];
export declare const LINE_WIDTH_NUMERIC_KEY = "line width";
export declare const LINE_WIDTH_PRESET_KEYS: string[];
export declare const LINE_WIDTH_ALL_OPTION_KEYS: string[];
export declare const TRANSFORM_KEY_ALIAS_CLEAR_KEYS: Record<TransformInspectorKey, readonly string[]>;
export declare function buildArrowTipSetPropertyMutation(context: ArrowTipWriteContext, side: ArrowTipSide, value: Exclude<ArrowTipPresetId, "custom">): ArrowTipSetPropertyMutation;
export declare function buildDashStyleSetPropertyMutation(value: Exclude<DashStylePresetId, "custom">): DashStyleSetPropertyMutation;
export declare function buildLineCapSetPropertyMutation(value: Exclude<LineCapPresetId, "custom">): LineCapSetPropertyMutation;
export declare function buildLineJoinSetPropertyMutation(value: Exclude<LineJoinPresetId, "custom">): LineJoinSetPropertyMutation;
export declare function buildLineWidthPresetSetPropertyMutation(presetKey: string): LineWidthSetPropertyMutation;
export declare function buildLineWidthValueSetPropertyMutation(value: string): LineWidthSetPropertyMutation;
export declare function buildFillModeSetPropertyMutations(value: Exclude<FillModePresetId, "custom">, context?: Partial<FillModeMutationContext>): FillModeSetPropertyMutation[];
export declare function buildFillShadingSetPropertyMutations(value: Exclude<FillShadingPresetId, "custom">): FillShadingSetPropertyMutation[];
export declare function buildFillPatternSetPropertyMutation(value: Exclude<FillPatternPresetId, "custom">): FillPatternSetPropertyMutation;
export declare function buildFillPatternOptionSetPropertyMutation(context: FillPatternOptionMutationContext, option: FillPatternMetaOptionKey, value: number): FillPatternOptionSetPropertyMutation;
export declare function buildPathMorphingDecorationSetPropertyMutations(value: Exclude<PathMorphingDecorationPresetId, "custom">): PathMorphingDecorationSetPropertyMutation[];
export declare function buildRoundedCornersSetPropertyMutation(enabled: boolean, radius?: number, disableRequiresSharpCorners?: boolean): RoundedCornersSetPropertyMutation;
export declare function buildNodeShapeSetPropertyMutation(value: Exclude<NodeShapePresetId, "custom">): NodeShapeSetPropertyMutation;
export declare function buildNodeInnerSepSetPropertyMutation(value: number): NodeInnerSepSetPropertyMutation;
export declare function buildNodeMinimumDimensionSetPropertyMutations(context: NodeMinimumDimensionsMutationContext, editedKey: NodeMinimumDimensionKey, nextValue: number): NodeMinimumDimensionSetPropertyMutation[];
export declare function buildNodeFontSetPropertyMutation(context: NodeFontMutationContext, values: {
    family: NodeFontFamilyId;
    weight: "normal" | "bold";
    style: "normal" | "italic";
    sizePreset: NodeFontSizePresetId;
    customSizePt: number | null;
}): NodeFontSetPropertyMutation;
export declare function resolveTransformInspectorMutationContext(source: string, targetId: string | null, parseOptions?: EditParseOptions, resolveTarget?: PropertyTargetResolver): TransformInspectorMutationContext;
export declare function resolveTransformInspectorMutationContextFromOptionEntries(entries: readonly OptionEntry[] | null | undefined): TransformInspectorMutationContext;
export declare function resolveTransformInspectorValues(source: string, targetId: string | null, parseOptions?: EditParseOptions, resolveTarget?: PropertyTargetResolver): TransformInspectorValues;
export declare function buildTransformSetPropertyMutations(current: TransformInspectorValues | TransformInspectorMutationContext, editedKey: TransformInspectorKey, nextValue: number): TransformSetPropertyMutation[];
export declare function buildShadowMutationContextForPreset(preset: ShadowPresetId): ShadowMutationContext;
export declare function buildShadowSetPropertyMutations(nextContext: ShadowMutationContext): ShadowSetPropertyMutation[];
export declare function cloneTransformInspectorValues(values: TransformInspectorValues): TransformInspectorValues;
export declare function transformRotateInspectorLabel(context: TransformInspectorValues | TransformInspectorMutationContext): string;
export declare function transformPropertyCandidateKeys(key: TransformInspectorKey): string[];
export { uniqueStrings } from "./statement-find.js";
