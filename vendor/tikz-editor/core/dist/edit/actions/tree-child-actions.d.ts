import type { EditActionResultLike } from "../result-types.js";
import { type EditParseOptions } from "../parse-options.js";
type AddTreeChildAction = {
    parentSourceId: string;
    afterChildIndex?: number;
};
type RemoveTreeChildAction = {
    childSourceId: string;
};
type AddTreeSiblingAction = {
    siblingSourceId: string;
    position: "before" | "after";
};
export declare function applyAddTreeChildAction(source: string, action: AddTreeChildAction, parseOptions?: EditParseOptions): EditActionResultLike;
export declare function applyAddTreeSiblingAction(source: string, action: AddTreeSiblingAction, parseOptions?: EditParseOptions): EditActionResultLike;
export declare function applyRemoveTreeChildAction(source: string, action: RemoveTreeChildAction, parseOptions?: EditParseOptions): EditActionResultLike;
export {};
