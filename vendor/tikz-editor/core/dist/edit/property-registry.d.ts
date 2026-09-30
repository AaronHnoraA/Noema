import type { OptionEntry } from "../options/types.js";
import type { ResolvedStyle } from "../semantic/types.js";
import { type DashStylePresetId, type FillModeMutationContext, type FillModePresetId, type FillPatternPresetId, type FillShadingPresetId, type LineCapPresetId, type LineJoinPresetId, type NodeShapePresetId, type TransformInspectorKey, type TransformInspectorMutationContext, type TransformInspectorValues } from "./property-write-builders.js";
export type SemanticPropertyId = "adornment-text-color" | "arrow-tip" | "dash-style" | "decorations.path-morphing" | "fill-axis-bottom-color" | "fill-axis-top-color" | "fill-ball-color" | "fill-color" | "fill-mode" | "fill-pattern" | "fill-pattern-color" | "fill-pattern-option" | "fill-radial-inner-color" | "fill-radial-outer-color" | "fill-shading" | "grid-step" | "grid-xstep" | "grid-ystep" | "line-cap" | "line-join" | "line-width" | "matrix-column-sep" | "matrix-draw-color" | "matrix-fill-color" | "matrix-row-sep" | "node-font" | "node-inner-sep" | "node-minimum-height" | "node-minimum-width" | "node-shape" | "node-text-align" | "node-text-color" | "node-text-width" | "rounded-corners" | "shadow-preset" | "stroke-color" | "stroke-opacity" | "fill-opacity" | "text-opacity" | "text" | "transform.rotate" | "transform.xscale" | "transform.xshift" | "transform.yscale" | "transform.yshift";
export type PropertyWriteMutation = {
    key: string;
    value: string;
    clearKeys?: string[];
    propertyId?: SemanticPropertyId;
};
export type PropertyWriteContext = {
    propertyId?: SemanticPropertyId;
    key?: string;
    value: string;
    clearKeys?: readonly string[];
};
export type PropertyCleanupKind = "paint-command";
export type PropertySemantics = {
    id: SemanticPropertyId;
    label: string;
    primaryKey: string;
    aliases?: readonly string[];
    conflictKeys?: readonly string[];
    candidateKeys?: readonly string[];
    addable?: boolean;
    addableKind?: string;
    defaultReversion?: "explicit" | "omit-if-equivalent";
    cleanup?: readonly PropertyCleanupKind[];
    buildMutations?: (context: PropertyWriteContext) => readonly PropertyWriteMutation[];
};
export type SetPropertyActionTarget = {
    elementId: string;
    level: string;
    key: string;
    propertyId?: SemanticPropertyId;
    writable: boolean;
};
export type RegistrySetPropertyAction = {
    kind: "setProperty";
    elementId: string;
    level: string;
    key: string;
    value: string;
    propertyId?: SemanticPropertyId;
    clearKeys?: string[];
};
export type PropertyMutationRequest = {
    kind: "dash-style";
    value: Exclude<DashStylePresetId, "custom">;
} | {
    kind: "fill-mode";
    value: Exclude<FillModePresetId, "custom">;
    context?: Partial<FillModeMutationContext>;
} | {
    kind: "fill-pattern";
    value: Exclude<FillPatternPresetId, "custom">;
} | {
    kind: "fill-shading";
    value: Exclude<FillShadingPresetId, "custom">;
} | {
    kind: "line-cap";
    value: Exclude<LineCapPresetId, "custom">;
} | {
    kind: "line-join";
    value: Exclude<LineJoinPresetId, "custom">;
} | {
    kind: "line-width-preset";
    key: string;
} | {
    kind: "line-width-value";
    value: string;
} | {
    kind: "node-inner-sep";
    value: number;
} | {
    kind: "node-shape";
    value: Exclude<NodeShapePresetId, "custom">;
} | {
    kind: "rounded-corners";
    enabled: boolean;
    radius?: number;
    disableRequiresSharpCorners?: boolean;
} | {
    kind: "transform";
    current: TransformInspectorValues | TransformInspectorMutationContext;
    key: TransformInspectorKey;
    value: number;
};
export declare const PROPERTY_REGISTRY: ReadonlyMap<SemanticPropertyId, PropertySemantics>;
export declare function getPropertySemantics(propertyId: string | null | undefined): PropertySemantics | null;
export declare function isSemanticPropertyId(value: string): value is SemanticPropertyId;
export declare function candidateKeysForProperty(propertyId: string | null | undefined): string[];
export declare function conflictKeysForProperty(propertyId: string | null | undefined): string[];
export declare function shouldOmitDefaultWhenEquivalent(propertyId: string | null | undefined): boolean;
export declare function propertyCleanupKinds(propertyId: string | null | undefined): readonly PropertyCleanupKind[];
export declare function isAddableProperty(propertyId: string, kind?: string): boolean;
export declare function addablePropertyKind(propertyId: string): string | null;
export declare function propertyIdForOptionEntry(entryOrKey: OptionEntry | string, availablePropertyIds?: ReadonlySet<string> | readonly string[]): SemanticPropertyId | null;
export declare function propertyIdForStyleContribution(key: keyof ResolvedStyle, availablePropertyIds?: ReadonlySet<string> | readonly string[]): SemanticPropertyId | null;
export declare function propertyIdForWriteKey(key: string, availablePropertyIds?: ReadonlySet<string> | readonly string[]): SemanticPropertyId | null;
export declare function buildPropertyMutations(context: PropertyWriteContext): PropertyWriteMutation[];
export declare function buildPropertyMutationsFromRequest(request: PropertyMutationRequest): PropertyWriteMutation[];
export declare function buildSetPropertyActionsForTargets(targets: readonly SetPropertyActionTarget[], context: PropertyWriteContext): RegistrySetPropertyAction[];
export { uniqueStrings } from "./statement-find.js";
