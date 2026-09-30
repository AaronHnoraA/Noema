import { englishDefaults } from '../languages/en.js';
const EXPLICIT_HYPHEN_CHARS = new Set(['-', '\u2010', '\u2011', '\u2012', '\u2013', '\u2014']);
const FORCED_BREAK_PENALTY = -10_000;
function itemWidthForRun(run, measurement) {
    if (run.kind === 'text') {
        measurement.precomputeWord(run.text, run.wrapper);
        return measurement.measureWord(run.text, run.wrapper);
    }
    if (run.kind === 'space') {
        if (run.texGlue) {
            return run.texGlue.width;
        }
        if (run.breakRef.kind === 'mspace') {
            return measurement.measureMath(run.wrapper);
        }
        return measurement.measureText(run.text, run.wrapper);
    }
    return measurement.measureMath(run.wrapper);
}
function addExplicitHyphenPenaltiesForTextRun(run, items, exhyphenpenalty) {
    if (run.text.length < 2) {
        return;
    }
    for (let i = 0; i < run.text.length - 1; i++) {
        const char = run.text[i];
        if (!EXPLICIT_HYPHEN_CHARS.has(char)) {
            continue;
        }
        const splitOffset = i + 1;
        items.push({
            kind: 'penalty',
            width: 0,
            penalty: exhyphenpenalty,
            flagged: true,
            payload: {
                runIndex: run.runIndex,
                breakKind: 'hyphen',
                sourceOffset: run.sourceStart + splitOffset,
                visibleHyphen: false,
                splitOffset,
                hyphenSource: 'explicit',
            },
        });
    }
}
function addAutomaticHyphenPenaltiesForTextRun(run, items, measurement, hyphenator, hyphenpenalty) {
    const splits = hyphenator.hyphenate(run.text);
    if (!splits.length) {
        return;
    }
    const hyphenWidth = measurement.measureText('-', run.wrapper);
    for (const splitOffset of splits) {
        if (splitOffset <= 0 || splitOffset >= run.text.length) {
            continue;
        }
        items.push({
            kind: 'penalty',
            width: hyphenWidth,
            penalty: hyphenpenalty,
            flagged: true,
            payload: {
                runIndex: run.runIndex,
                breakKind: 'hyphen',
                sourceOffset: run.sourceStart + splitOffset,
                visibleHyphen: true,
                splitOffset,
                hyphenSource: 'automatic',
            },
        });
    }
}
export function runsToItems(runs, measurement, options = {}) {
    const items = [];
    const errors = [];
    const runWidths = new Map();
    const hyphenator = options.hyphenator ?? null;
    const enableAutomaticHyphenation = options.enableAutomaticHyphenation ?? false;
    const hyphenpenalty = options.hyphenpenalty ?? englishDefaults.hyphenpenalty;
    const exhyphenpenalty = options.exhyphenpenalty ?? englishDefaults.exhyphenpenalty;
    for (const run of runs) {
        const width = itemWidthForRun(run, measurement);
        runWidths.set(run.runIndex, width);
        if (run.kind === 'text') {
            items.push({
                kind: 'box',
                width,
                payload: {
                    runIndex: run.runIndex,
                    runKind: 'text',
                    text: run.text,
                },
            });
            addExplicitHyphenPenaltiesForTextRun(run, items, exhyphenpenalty);
            if (enableAutomaticHyphenation) {
                if (!hyphenator) {
                    errors.push('Automatic hyphenation requested but no hyphenator instance is configured.');
                }
                else {
                    addAutomaticHyphenPenaltiesForTextRun(run, items, measurement, hyphenator, hyphenpenalty);
                }
            }
            continue;
        }
        if (run.kind === 'space') {
            const isForcedMspaceBreak = run.breakRef.kind === 'mspace' && run.breakRef.isForcedLineBreak === true;
            if (isForcedMspaceBreak) {
                items.push({
                    kind: 'penalty',
                    width: 0,
                    penalty: FORCED_BREAK_PENALTY,
                    payload: {
                        runIndex: run.runIndex,
                        breakRef: run.breakRef,
                        breakKind: 'forced',
                        sourceOffset: run.sourceEnd,
                        visibleHyphen: false,
                    },
                });
                continue;
            }
            const stretch = run.texGlue?.stretch ?? options.spaceStretch ?? 0;
            const shrink = run.texGlue?.shrink ?? options.spaceShrink ?? 0;
            items.push({
                kind: 'glue',
                width,
                stretch,
                shrink,
                payload: {
                    runIndex: run.runIndex,
                    breakRef: run.breakRef,
                },
            });
            items.push({
                kind: 'penalty',
                width: 0,
                penalty: 0,
                payload: {
                    runIndex: run.runIndex,
                    breakRef: run.breakRef,
                    breakKind: 'space',
                    sourceOffset: run.sourceEnd,
                    visibleHyphen: false,
                },
            });
            continue;
        }
        if (run.kind !== 'math') {
            errors.push('Unsupported run kind.');
            continue;
        }
        items.push({
            kind: 'box',
            width,
            payload: {
                runIndex: run.runIndex,
                runKind: 'math',
            },
        });
    }
    return {
        runs,
        items,
        runWidths,
        errors,
        measurement,
    };
}
export function getBreakableRunIndices(items) {
    const indices = new Set();
    for (const item of items) {
        if (item.kind === 'penalty' && item.penalty < 10_000) {
            indices.add(item.payload.runIndex);
        }
    }
    return indices;
}
