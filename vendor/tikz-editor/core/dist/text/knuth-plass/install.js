import { KnuthPlassVisitor } from './KnuthPlassVisitor.js';
import { clearKnuthPlassCaretMappingCache, getKnuthPlassCaretFromPoint, getKnuthPlassLineRangeFromPoint, getKnuthPlassPointFromOffset, getKnuthPlassSelectionRects, } from './editor/hitmap.js';
export function installKnuthPlassVisitor(config, outputs = ['svg']) {
    for (const output of outputs) {
        const outputConfig = (config[output] ??= {});
        const linebreaks = (outputConfig.linebreaks ??= {});
        linebreaks.LinebreakVisitor = KnuthPlassVisitor;
    }
    return config;
}
export function setKnuthPlassOptionsOnOutputJax(outputJax, options) {
    if (!outputJax || typeof outputJax !== 'object') {
        return;
    }
    if (!options || typeof options !== 'object') {
        return;
    }
    const target = outputJax;
    const existing = target.knuthPlassOptions && typeof target.knuthPlassOptions === 'object'
        ? target.knuthPlassOptions
        : {};
    target.knuthPlassOptions = {
        ...existing,
        ...options,
    };
}
export function getKnuthPlassReportsFromOutputJax(outputJax) {
    if (!outputJax || typeof outputJax !== 'object') {
        return [];
    }
    const target = outputJax;
    const fromVisitor = target.linebreaks?.getReports?.();
    if (Array.isArray(fromVisitor)) {
        return fromVisitor;
    }
    return [];
}
export { getKnuthPlassCaretFromPoint, getKnuthPlassLineRangeFromPoint, getKnuthPlassPointFromOffset, getKnuthPlassSelectionRects, clearKnuthPlassCaretMappingCache, };
