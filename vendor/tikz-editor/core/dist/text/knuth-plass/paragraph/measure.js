export function createMeasurementService() {
    const textWidthCache = new Map();
    const wordPrefixWidthCache = new Map();
    const mathWidthCache = new WeakMap();
    const wrapperIds = new WeakMap();
    let nextWrapperId = 1;
    const stats = {
        mathEntries: 0,
    };
    const getWrapperId = (wrapper) => {
        if (!wrapper || typeof wrapper !== 'object')
            return 0;
        if (!wrapperIds.has(wrapper)) {
            wrapperIds.set(wrapper, nextWrapperId++);
        }
        return wrapperIds.get(wrapper);
    };
    const textKey = (text, wrapper) => {
        return `${getWrapperId(wrapper)}::${text}`;
    };
    const measureText = (text, mtextWrapper) => {
        const key = textKey(text, mtextWrapper);
        const cached = textWidthCache.get(key);
        if (cached !== undefined) {
            return cached;
        }
        if (!mtextWrapper || typeof mtextWrapper.textWidth !== 'function') {
            throw new Error('Missing textWidth() on mtext wrapper for strict measurement.');
        }
        const width = Number(mtextWrapper.textWidth(text)) || 0;
        textWidthCache.set(key, width);
        return width;
    };
    const buildPrefixWidths = (word, mtextWrapper) => {
        const key = textKey(word, mtextWrapper);
        const existing = wordPrefixWidthCache.get(key);
        if (existing) {
            return existing;
        }
        const widths = Array.from({ length: word.length + 1 }, () => 0);
        widths[0] = 0;
        for (let i = 1; i <= word.length; i++) {
            widths[i] = measureText(word.slice(0, i), mtextWrapper);
        }
        wordPrefixWidthCache.set(key, widths);
        return widths;
    };
    const precomputeWord = (word, mtextWrapper) => {
        void measureText(word, mtextWrapper);
    };
    const measureWord = (word, mtextWrapper) => {
        return measureText(word, mtextWrapper);
    };
    const measurePrefix = (word, n, mtextWrapper) => {
        const widths = buildPrefixWidths(word, mtextWrapper);
        const clamped = Math.max(0, Math.min(n, word.length));
        return widths[clamped] || 0;
    };
    const measureMath = (wrapper) => {
        if (!wrapper || typeof wrapper !== 'object')
            return 0;
        const cached = mathWidthCache.get(wrapper);
        if (cached !== undefined) {
            return cached;
        }
        const bbox = typeof wrapper.getOuterBBox === 'function'
            ? wrapper.getOuterBBox()
            : typeof wrapper.getBBox === 'function'
                ? wrapper.getBBox()
                : null;
        const width = bbox
            ? (Number(bbox.L) || 0) + (Number(bbox.w) || 0) + (Number(bbox.R) || 0)
            : 0;
        mathWidthCache.set(wrapper, width);
        stats.mathEntries += 1;
        return width;
    };
    const primeRuns = (runs) => {
        for (const run of runs) {
            if (run.kind === 'text') {
                precomputeWord(run.text, run.wrapper);
            }
            else if (run.kind === 'space') {
                if (run.breakRef.kind === 'mspace') {
                    measureMath(run.wrapper);
                }
                else {
                    measureText(' ', run.wrapper);
                }
            }
            else {
                measureMath(run.wrapper);
            }
        }
    };
    const getStats = () => {
        return {
            textCacheEntries: textWidthCache.size,
            wordPrefixEntries: wordPrefixWidthCache.size,
            mathCacheEntries: stats.mathEntries,
        };
    };
    return {
        measureText,
        measureWord,
        measurePrefix,
        measureMath,
        precomputeWord,
        primeRuns,
        getStats,
    };
}
