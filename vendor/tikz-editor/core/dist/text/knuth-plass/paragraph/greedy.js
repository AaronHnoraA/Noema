function skipLeadingSpaces(model, index) {
    let i = index;
    while (i < model.runs.length && model.runs[i].kind === 'space') {
        i++;
    }
    return i;
}
function runWidth(model, runIndex) {
    return model.runWidths.get(runIndex) ?? 0;
}
export function greedyBreakParagraph(model, targetWidth) {
    const lines = [];
    const errors = [];
    if (targetWidth <= 0) {
        return {
            lines: [
                {
                    lineIndex: 0,
                    startRun: 0,
                    startTextOffset: 0,
                    endRun: Math.max(0, model.runs.length - 1),
                    endTextOffset: null,
                    width: model.runs.reduce((sum, run) => sum + (model.runWidths.get(run.runIndex) ?? 0), 0),
                    break: null,
                },
            ],
            errors: ['Target width was non-positive; linebreaking was skipped.'],
        };
    }
    const breakableRunIndices = new Set();
    for (const item of model.items) {
        if (item.kind !== 'penalty')
            continue;
        if (item.payload.breakKind !== 'space')
            continue;
        if (item.penalty >= 1_000_000)
            continue;
        breakableRunIndices.add(item.payload.runIndex);
    }
    let index = skipLeadingSpaces(model, 0);
    let lineIndex = 0;
    while (index < model.runs.length) {
        const lineStart = index;
        let width = 0;
        let lastBreakRunIndex = null;
        let widthBeforeBreak = 0;
        while (index < model.runs.length) {
            const run = model.runs[index];
            const nextWidth = width + runWidth(model, run.runIndex);
            if (nextWidth > targetWidth && index > lineStart) {
                break;
            }
            width = nextWidth;
            if (breakableRunIndices.has(run.runIndex)) {
                lastBreakRunIndex = run.runIndex;
                widthBeforeBreak = width - runWidth(model, run.runIndex);
            }
            index++;
        }
        if (index >= model.runs.length) {
            lines.push({
                lineIndex,
                startRun: lineStart,
                startTextOffset: 0,
                endRun: model.runs.length - 1,
                endTextOffset: null,
                width,
                break: null,
            });
            break;
        }
        if (lastBreakRunIndex !== null && lastBreakRunIndex >= lineStart) {
            lines.push({
                lineIndex,
                startRun: lineStart,
                startTextOffset: 0,
                endRun: Math.max(lineStart, lastBreakRunIndex - 1),
                endTextOffset: null,
                width: widthBeforeBreak,
                break: {
                    kind: 'space',
                    runIndex: lastBreakRunIndex,
                    sourceOffset: model.runs[lastBreakRunIndex]?.sourceEnd ?? 0,
                    visibleHyphen: false,
                },
            });
            index = skipLeadingSpaces(model, lastBreakRunIndex + 1);
            lineIndex++;
            continue;
        }
        lines.push({
            lineIndex,
            startRun: lineStart,
            startTextOffset: 0,
            endRun: index - 1,
            endTextOffset: null,
            width,
            break: null,
        });
        index = skipLeadingSpaces(model, index);
        lineIndex++;
    }
    return { lines, errors };
}
