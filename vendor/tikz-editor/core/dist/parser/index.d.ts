import type { Tree } from "@lezer/common";
import type { Diagnostic } from "../diagnostics/types.js";
import type { NodeItem } from "../ast/types.js";
import { FeatureFlags } from "../ast/features.js";
import type { TikzFigure, TikzFigureInventoryItem } from "../ast/types.js";
export type NodeTextValidationContext = {
    node: NodeItem;
    source: string;
};
export type NodeTextValidationIssue = {
    code?: string;
    message: string;
};
export type ParseTikzOptions = {
    recover?: boolean;
    activeFigureId?: string | null;
    includeContextDefinitions?: boolean;
    nodeTextValidator?: (context: NodeTextValidationContext) => NodeTextValidationIssue | null;
};
export type ParseTikzResult = {
    source: string;
    tree: Tree;
    figure: TikzFigure;
    figures: TikzFigureInventoryItem[];
    activeFigureId: string | null;
    diagnostics: Diagnostic[];
    features: typeof FeatureFlags;
};
export declare function parseTikz(input: string, opts?: ParseTikzOptions): ParseTikzResult;
export type { Diagnostic } from "../diagnostics/types.js";
export type * from "../ast/types.js";
export { createIncrementalParseSession } from "./incremental.js";
export type * from "./incremental.js";
