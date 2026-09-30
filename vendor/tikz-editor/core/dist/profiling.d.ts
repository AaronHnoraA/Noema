export type TikzEditorProfilingCounter = "parseTikzCalls" | "parseTikzForEditCalls" | "resolvePropertyTargetCalls" | "buildStylesCascadeModelCalls" | "resolveColorSyntaxValueCalls";
export type TikzEditorProfilingComputeTiming = {
    requestId: string;
    kind: string;
    trigger?: string | null;
    durationMs: number;
    changedSourceCount?: number;
    incremental?: boolean;
    parseStrategy?: string | null;
    parseFallbackReason?: string | null;
    parsePatchApplication?: string | null;
    parsePatchBaseRevision?: number | null;
    sourceRevision?: number | null;
    semanticStrategy?: string | null;
    semanticFallbackReason?: string | null;
    recomputedStatementCount?: number | null;
    reusedStatementCount?: number | null;
    phaseDurationsMs?: Record<string, number>;
};
export type TikzEditorProfilingSvgPatchTiming = {
    durationMs: number;
    operationCount: number;
    forceReplaceAll: boolean;
    hasReplaceAll: boolean;
    hasReplaceDefs: boolean;
    fallbackReason?: string | null;
};
export type TikzEditorProfilingSourcePanelSyncTiming = {
    kind: "externalSyncDispatch";
    durationMs: number;
    mode: "patch" | "replace";
    trustedPatch?: boolean;
    coalescedToAnimationFrame: boolean;
    patchCount: number;
    docLength: number;
};
export type TikzEditorProfilingRecorder = {
    incrementCounter: (counter: TikzEditorProfilingCounter, amount?: number) => void;
    recordComputeTiming: (timing: TikzEditorProfilingComputeTiming) => void;
    recordSvgPatchTiming: (timing: TikzEditorProfilingSvgPatchTiming) => void;
    recordSourcePanelSyncTiming: (timing: TikzEditorProfilingSourcePanelSyncTiming) => void;
};
declare global {
    var __TIKZ_EDITOR_PROFILING_RECORDER__: TikzEditorProfilingRecorder | undefined;
}
export declare function incrementProfilingCounter(counter: TikzEditorProfilingCounter, amount?: number): void;
export declare function recordProfilingComputeTiming(timing: TikzEditorProfilingComputeTiming): void;
export declare function recordProfilingSvgPatchTiming(timing: TikzEditorProfilingSvgPatchTiming): void;
export declare function recordProfilingSourcePanelSyncTiming(timing: TikzEditorProfilingSourcePanelSyncTiming): void;
