import { parseTikz } from "../parser/index.js";
import { incrementProfilingCounter } from "../profiling.js";
import { computeSourceFingerprint } from "../utils/source-fingerprint.js";
export function parseTikzForEdit(source, options = {}) {
    incrementProfilingCounter("parseTikzForEditCalls");
    if (options.analysisView?.source === source &&
        options.analysisView.activeFigureId === options.activeFigureId) {
        return options.analysisView.parseResult;
    }
    if (options.analysisSession) {
        return options.analysisSession.ensure(source, {
            activeFigureId: options.activeFigureId
        }).parseResult;
    }
    return parseTikz(source, {
        recover: true,
        activeFigureId: options.activeFigureId,
        // Edit queries resolve scene/source ids produced by the main compute path,
        // so they must preserve the same statement numbering.
        includeContextDefinitions: true
    });
}
export function sourceFingerprintForEdit(source, options = {}) {
    return options.sourceFingerprint ?? computeSourceFingerprint(source);
}
