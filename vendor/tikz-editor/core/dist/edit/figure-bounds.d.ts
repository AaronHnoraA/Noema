import type { Span } from "../ast/types.js";
import { type EditParseOptions } from "./parse-options.js";
import type { EditActionResult } from "./actions.js";
export type FigureBoundsState = {
    mode: "auto";
} | {
    mode: "fixed";
    x: number;
    y: number;
    width: number;
    height: number;
    sourceId: string;
    span: Span;
};
export type SetFigureBoundsAction = {
    kind: "setFigureBounds";
    mode: "auto";
} | {
    kind: "setFigureBounds";
    mode: "fixed";
    x: number;
    y: number;
    width: number;
    height: number;
};
export declare function resolveFigureBoundsState(source: string, parseOptions?: EditParseOptions): FigureBoundsState;
export declare function applySetFigureBoundsAction(source: string, action: SetFigureBoundsAction, parseOptions?: EditParseOptions): EditActionResult;
