import { type DragFormatPrecision } from "../format.js";
import type { PropertyTarget } from "../property-target.js";
import { type OptionMutation } from "../option-mutations.js";
import type { EditActionResult } from "../actions.js";
type SetPropertyActionLike = {
    elementId: string;
    key: string;
    value: string;
    clearKeys?: string[];
};
export declare const ADORNMENT_EDIT_NOOP_REASON = "Adornment edit would not change the source.";
export declare function applyAdornmentSetProperty(source: string, target: PropertyTarget, action: SetPropertyActionLike): EditActionResult;
export declare function applyAdornmentValueRewrite(source: string, target: PropertyTarget, overrides: {
    angleRaw?: string;
    textRaw?: string;
    distancePt?: number;
} | undefined, selectedTargetId: string, pinEdgeMutations?: ReadonlyMap<string, OptionMutation>, optionMutations?: ReadonlyMap<string, OptionMutation>, formatPrecision?: DragFormatPrecision): EditActionResult;
export {};
