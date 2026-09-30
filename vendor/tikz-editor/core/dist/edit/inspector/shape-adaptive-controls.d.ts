import type { OptionListAst } from "../../options/types.js";
import type { NodeShapePresetId } from "./presets.js";
type ShapeAdaptiveControlBase = {
    id: string;
    label: string;
    writeKey: string;
    clearKeys?: string[];
};
type ShapeAdaptiveNumberControl = ShapeAdaptiveControlBase & {
    kind: "number";
    value: number;
    step: number;
    min?: number;
    max?: number;
    unit?: string;
};
type ShapeAdaptiveLengthControl = ShapeAdaptiveControlBase & {
    kind: "length";
    value: number;
    step: number;
};
type ShapeAdaptiveEnumControl = ShapeAdaptiveControlBase & {
    kind: "enum";
    value: string;
    options: Array<{
        value: string;
        label: string;
    }>;
};
type ShapeAdaptiveBooleanControl = ShapeAdaptiveControlBase & {
    kind: "boolean";
    value: boolean;
    trueValue?: string;
    falseValue?: string;
};
export type ShapeAdaptiveControl = ShapeAdaptiveNumberControl | ShapeAdaptiveLengthControl | ShapeAdaptiveEnumControl | ShapeAdaptiveBooleanControl;
export declare function resolveNodeShapeAdaptiveControls(shape: Exclude<NodeShapePresetId, "custom">, options: OptionListAst | undefined): ShapeAdaptiveControl[];
export {};
