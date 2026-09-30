import { parseTikz } from "../parser/index.js";
import { resolveFigurePropertyTargetFromParseResult, resolvePropertyTargetFromParseResult } from "./property-target.js";
import { buildStatementSnapshotFromStatements } from "./statement-ops.js";
export function createEditAnalysisSession() {
    let cached = null;
    // Keep the previous entry so that callers with a slightly stale source
    // (e.g. snapshot.source that hasn't caught up to the latest edit) still
    // get a cache hit instead of triggering a redundant full parse.
    let previous = null;
    const lookup = (source, activeFigureId) => {
        if (cached?.source === source && cached.activeFigureId === activeFigureId) {
            return cached;
        }
        if (previous?.source === source && previous.activeFigureId === activeFigureId) {
            return previous;
        }
        return null;
    };
    const store = (entry) => {
        if (cached && cached !== entry) {
            previous = cached;
        }
        cached = entry;
    };
    const ensure = (source, options = {}) => {
        const activeFigureId = options.activeFigureId;
        const hit = lookup(source, activeFigureId);
        if (hit) {
            return hit.view;
        }
        const parseResult = parseTikz(source, {
            recover: true,
            activeFigureId,
            includeContextDefinitions: true
        });
        const entry = createCache(source, parseResult, activeFigureId);
        store(entry);
        return entry.view;
    };
    return {
        primeFromParse(parse, _source, options = {}) {
            const activeFigureId = options.activeFigureId ?? parse.activeFigureId;
            const source = parse.source;
            const hit = lookup(source, activeFigureId);
            if (hit?.parseResult === parse) {
                return hit.view;
            }
            const entry = createCache(source, parse, activeFigureId);
            store(entry);
            return entry.view;
        },
        ensure,
        reset() {
            cached = null;
            previous = null;
        }
    };
}
function createCache(source, parseResult, activeFigureId) {
    const statementSnapshot = buildStatementSnapshotFromStatements(source, parseResult.figure.body);
    const propertyTargetCache = new Map();
    const pathStatementCache = new Map();
    const cache = {
        source,
        activeFigureId,
        parseResult,
        statementSnapshot,
        propertyTargetCache,
        pathStatementCache,
        figureTargetCache: null,
        view: null
    };
    cache.view = {
        source,
        activeFigureId,
        parseResult,
        statementSnapshot,
        resolvePropertyTarget(elementId) {
            const cachedResolution = propertyTargetCache.get(elementId);
            if (cachedResolution) {
                return cachedResolution;
            }
            const resolution = resolvePropertyTargetFromParseResult(source, parseResult, elementId);
            propertyTargetCache.set(elementId, resolution);
            return resolution;
        },
        resolveFigurePropertyTarget() {
            if (cache.figureTargetCache) {
                return cache.figureTargetCache;
            }
            const resolution = resolveFigurePropertyTargetFromParseResult(source, parseResult);
            cache.figureTargetCache = resolution;
            return resolution;
        },
        findPathStatement(sourceId) {
            if (pathStatementCache.has(sourceId)) {
                return pathStatementCache.get(sourceId) ?? null;
            }
            const statement = findPathStatementInStatements(parseResult.figure.body, sourceId);
            pathStatementCache.set(sourceId, statement);
            return statement;
        }
    };
    return cache;
}
function findPathStatementInStatements(statements, sourceId) {
    for (const statement of statements) {
        if (statement.kind === "Path" && statement.id === sourceId) {
            return statement;
        }
        if (statement.kind === "Scope") {
            const nested = findPathStatementInStatements(statement.body, sourceId);
            if (nested) {
                return nested;
            }
        }
    }
    return null;
}
