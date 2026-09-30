import { scanTikzFigures } from "./figure-scan.js";
let contextDefinitionCache = null;
export function getCachedContextDefinitions(prefix, collectContextDefinitions) {
    const cache = contextDefinitionCache;
    if (cache?.prefix === prefix) {
        return cache.definitions;
    }
    const definitions = collectContextDefinitions(prefix);
    contextDefinitionCache = { prefix, definitions };
    return definitions;
}
export function resolveParseWindowSource(source, activeFigureSpan) {
    if (!activeFigureSpan) {
        return source;
    }
    const safeFrom = Math.max(0, Math.min(source.length, activeFigureSpan.from));
    const safeTo = Math.max(safeFrom, Math.min(source.length, activeFigureSpan.to));
    const prefix = source.slice(0, safeFrom).replace(/[^\n]/g, " ");
    const figure = source.slice(safeFrom, safeTo);
    return `${prefix}${figure}`;
}
export function resolveActiveFigureSpan(spans, activeFigureId) {
    if (activeFigureId === null) {
        return null;
    }
    if (spans.length === 0) {
        return null;
    }
    const requestedIndex = activeFigureId ? parseFigureIndexFromId(activeFigureId) : 0;
    const index = requestedIndex != null && requestedIndex >= 0 && requestedIndex < spans.length
        ? requestedIndex
        : 0;
    return spans[index] ?? null;
}
export function scanFigureSpans(source) {
    return scanTikzFigures(source)
        .filter((figure) => !figure.isTemplate)
        .map((figure) => ({ from: figure.span.from, to: figure.span.to }));
}
export function parseFigureIndexFromId(figureId) {
    const match = /^figure:(\d+)(?::|$)/u.exec(figureId.trim());
    if (!match?.[1]) {
        return null;
    }
    const parsed = Number.parseInt(match[1], 10);
    return Number.isFinite(parsed) ? parsed : null;
}
