import type { ParseTikzResult } from "../parser/index.js";
import type { CoordinateItem, NodeItem, PathItem } from "../ast/types.js";
import type { EditHandle } from "../semantic/types.js";
import type { ApplyEditResult, EditIntent, EditIntentResult, TikzEdit } from "./types.js";
import type { EditParseOptions } from "./parse-options.js";
export declare function applyEdit(parseResult: ParseTikzResult, edit: TikzEdit): ApplyEditResult;
export declare function applyEditIntent(source: string, editHandles: EditHandle[], intent: EditIntent, parseOptions?: EditParseOptions): EditIntentResult;
export declare function isCoordinateItem(item: PathItem): item is CoordinateItem;
export declare function isNodeItem(item: PathItem): item is NodeItem;
