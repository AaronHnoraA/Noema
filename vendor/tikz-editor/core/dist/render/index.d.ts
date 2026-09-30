import type { ParseTikzOptions, ParseTikzResult } from "../parser/index.js";
import type { EvaluateOptions, EvaluateTikzResult } from "../semantic/index.js";
import type { EmitSvgOptions, EmitSvgResult } from "../svg/index.js";
import type { NodeTextEngine } from "../text/types.js";
export type RenderTikzOptions = {
    parse?: ParseTikzOptions;
    evaluate?: EvaluateOptions;
    svg?: EmitSvgOptions;
    textEngine?: NodeTextEngine | null;
    validateNodeText?: boolean;
};
export type RenderDiagnostic = {
    code: string;
    message: string;
    severity: "warning" | "error";
};
export type RenderTikzToSvgResult = {
    parse: ParseTikzResult;
    semantic: EvaluateTikzResult;
    svg: EmitSvgResult;
    renderDiagnostics: RenderDiagnostic[];
};
export declare function renderTikzToSvg(source: string, opts?: RenderTikzOptions): RenderTikzToSvgResult;
export declare function renderTikzToSvgAsync(source: string, opts?: RenderTikzOptions): Promise<RenderTikzToSvgResult>;
