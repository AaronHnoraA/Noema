import type { ParseTikzOptions, ParseTikzResult } from "./index.js";
import type { SourcePatch } from "../edit/types.js";
export type IncrementalParseTrigger = "drag-element" | "drag-handle" | "other";
export type IncrementalParseFallbackReason = "non-drag-trigger" | "missing-patches" | "no-previous-cache" | "source-unchanged-active-figure-mismatch" | "active-figure-unresolved" | "active-figure-mismatch" | "global-diagnostics" | "patch-outside-active-figure" | "patch-touches-figure-delimiter" | "patch-source-id-mismatch" | "patch-overlaps-unknown-statement" | "statement-structure-changed" | "statement-parse-error" | "statement-global-diagnostics" | "runtime-error";
export type IncrementalParseStats = {
    strategy: "full" | "incremental" | "reused";
    fallbackReason?: IncrementalParseFallbackReason;
    patchApplication?: "direct" | "rebased" | "discarded";
    reparsedStatementCount: number;
    reusedStatementCount: number;
};
export type IncrementalParseEvaluateInput = {
    source: string;
    sourceRevision?: number | null;
    activeFigureId?: string | null;
    includeContextDefinitions?: boolean;
    patches?: readonly SourcePatch[] | null;
    patchBaseRevision?: number | null;
    changedSourceIds?: readonly string[];
    trigger?: IncrementalParseTrigger;
};
export type IncrementalParseEvaluateResult = {
    parse: ParseTikzResult;
    stats: IncrementalParseStats;
};
export type IncrementalParseSession = {
    evaluate: (input: IncrementalParseEvaluateInput) => IncrementalParseEvaluateResult;
    prime: (parse: ParseTikzResult, options?: Pick<ParseTikzOptions, "activeFigureId" | "includeContextDefinitions"> & {
        sourceRevision?: number | null;
    }) => void;
    reset: () => void;
};
export declare function createIncrementalParseSession(): IncrementalParseSession;
