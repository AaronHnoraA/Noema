import type { EditActionResultLike } from "../result-types.js";
import type { Statement } from "../../ast/types.js";
import type { EditParseOptions } from "../parse-options.js";
export declare function applyGroupElementsAction(source: string, elementIds: readonly string[], parseOptions?: EditParseOptions): EditActionResultLike;
export declare function applyUngroupElementsAction(source: string, elementIds: readonly string[], parseOptions?: EditParseOptions): EditActionResultLike;
export declare function isUngroupableScopeStatement(statement: Statement): boolean;
