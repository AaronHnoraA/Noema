function getRecorder() {
    return globalThis.__TIKZ_EDITOR_PROFILING_RECORDER__ ?? null;
}
export function incrementProfilingCounter(counter, amount = 1) {
    getRecorder()?.incrementCounter(counter, amount);
}
export function recordProfilingComputeTiming(timing) {
    getRecorder()?.recordComputeTiming(timing);
}
export function recordProfilingSvgPatchTiming(timing) {
    getRecorder()?.recordSvgPatchTiming(timing);
}
export function recordProfilingSourcePanelSyncTiming(timing) {
    getRecorder()?.recordSourcePanelSyncTiming(timing);
}
