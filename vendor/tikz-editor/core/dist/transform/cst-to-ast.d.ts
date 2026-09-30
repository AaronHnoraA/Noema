import type { Tree } from "@lezer/common";
import type { Diagnostic } from "../diagnostics/types.js";
import type { Statement, TikzFigure, TikzFigureInventoryItem } from "../ast/types.js";
import { type ScannedFigure } from "../parser/figure-scan.js";
export type CstToAstResult = {
    figure: TikzFigure;
    figures: TikzFigureInventoryItem[];
    activeFigureId: string | null;
    diagnostics: Diagnostic[];
};
export type CstToIrResult = CstToAstResult;
export type CstToAstOptions = {
    activeFigureId?: string | null;
    includeContextDefinitions?: boolean;
    contextDefinitions?: Statement[];
    scannedFigures?: readonly ScannedFigure[];
};
export declare function fromCst(tree: Tree, source: string, opts?: CstToAstOptions): CstToAstResult;
export declare function collectContextDefinitions(source: string): Statement[];
