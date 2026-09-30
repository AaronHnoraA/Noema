import type { Span } from "../ast/types.js";
import type { SourcePatch } from "../edit/types.js";
import type { ForeachExpansionDiagnostic } from "./types.js";
export type FlattenForeachTarget = {
    kind: "sourceId";
    sourceId: string;
} | {
    kind: "span";
    span: Span;
};
export type FlattenForeachOptions = {
    recursive?: boolean;
    maxExpansions?: number;
};
export type FlattenForeachPatch = SourcePatch;
export type FlattenForeachResult = {
    kind: "success";
    newSource: string;
    patches: FlattenForeachPatch[];
    flattenedLoopId: string;
    flattenedSpan: Span;
    warnings: ForeachExpansionDiagnostic[];
} | {
    kind: "unsupported";
    reason: string;
    diagnostics: ForeachExpansionDiagnostic[];
} | {
    kind: "error";
    message: string;
};
export declare function flattenForeachInSource(source: string, target: FlattenForeachTarget, options?: FlattenForeachOptions): FlattenForeachResult;
