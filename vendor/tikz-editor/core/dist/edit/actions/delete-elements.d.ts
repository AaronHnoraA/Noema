import type { EditActionResultLike } from "../result-types.js";
import { type EditParseOptions } from "../parse-options.js";
export declare function applyDeleteElementsAction(source: string, elementIds: readonly string[], parseOptions?: EditParseOptions): EditActionResultLike;
export declare function applyDeleteAdornmentAction(source: string, targetId: string, parseOptions?: EditParseOptions): EditActionResultLike;
