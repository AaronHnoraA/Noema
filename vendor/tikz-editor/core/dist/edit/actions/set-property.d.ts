import type { EditActionResultLike } from "../result-types.js";
import type { EditParseOptions } from "../parse-options.js";
import type { SemanticPropertyId } from "../property-registry.js";
export type SetPropertyAction = {
    elementId: string;
    key: string;
    value: string;
    propertyId?: SemanticPropertyId;
    clearKeys?: string[];
    commentMode?: "disable" | "enable";
    commentSourceText?: string;
};
export declare function applySetPropertyAction(source: string, action: SetPropertyAction, parseOptions?: EditParseOptions): EditActionResultLike;
export declare function applySetPropertyActionRaw(source: string, action: SetPropertyAction, parseOptions?: EditParseOptions): EditActionResultLike;
