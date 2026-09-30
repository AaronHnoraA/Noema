import type { Span, TikzFigure } from "../ast/types.js";
import { type EvaluateTikzResult } from "./evaluate.js";
import type { EvaluateOptions } from "./types.js";
export type IncrementalSemanticTrigger = "drag-element" | "drag-handle" | "other";
export type IncrementalSemanticReplayMode = "full" | "suffix" | "selective";
export type IncrementalSemanticHints = {
    changedSourceIds?: readonly string[];
    sourcePatches?: readonly {
        newSpan?: Span;
        replacement: string;
    }[];
    trigger?: IncrementalSemanticTrigger;
};
export type IncrementalSemanticFallbackReason = "non-drag-trigger" | "missing-changed-source-ids" | "no-previous-cache" | "statement-structure-changed" | "stateful-graphics-state" | "opaque-dependency" | "unmapped-affected-source" | "checkpoint-missing" | "feature-checkpoint-missing" | "restore-failed" | "selective-replay-error" | "runtime-error";
export type IncrementalSemanticStats = {
    strategy: "full" | "incremental";
    replayMode?: IncrementalSemanticReplayMode;
    recomputeFromStatementIndex: number | null;
    recomputedStatementCount: number;
    reusedStatementCount: number;
    corridorEndStatementIndex?: number | null;
    affectedStatementCount?: number;
    fallbackReason?: IncrementalSemanticFallbackReason;
};
export type IncrementalSemanticEvaluateInput = {
    figure: TikzFigure;
    source: string;
    options?: EvaluateOptions;
    hints?: IncrementalSemanticHints;
};
export type IncrementalSemanticEvaluateResult = {
    semantic: EvaluateTikzResult;
    stats: IncrementalSemanticStats;
};
export type IncrementalSemanticSession = {
    evaluate: (input: IncrementalSemanticEvaluateInput) => IncrementalSemanticEvaluateResult;
    reset: () => void;
};
export declare function createIncrementalSemanticSession(defaultOptions?: EvaluateOptions): IncrementalSemanticSession;
