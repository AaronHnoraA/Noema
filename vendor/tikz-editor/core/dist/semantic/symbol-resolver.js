function createScopeFrame() {
    return {
        macro: new Map(),
        color: new Map(),
        style: new Map(),
        key: new Map(),
        library: new Map()
    };
}
function normalizeSymbolName(kind, name) {
    const trimmed = name.trim();
    if (kind === "library") {
        return trimmed.toLowerCase();
    }
    return trimmed;
}
function mapForKind(frame, kind) {
    if (kind === "macro") {
        return frame.macro;
    }
    if (kind === "color") {
        return frame.color;
    }
    if (kind === "style") {
        return frame.style;
    }
    if (kind === "key") {
        return frame.key;
    }
    return frame.library;
}
export function createSemanticSymbolResolver() {
    return {
        scopes: [createScopeFrame()],
        dependencyEdges: new Map(),
        unresolvedSymbols: new Map(),
        requiredLibraries: new Set()
    };
}
export function pushSemanticSymbolScope(resolver) {
    resolver.scopes.push(createScopeFrame());
}
export function popSemanticSymbolScope(resolver) {
    if (resolver.scopes.length > 1) {
        resolver.scopes.pop();
    }
}
export function defineSemanticSymbol(resolver, definition) {
    const normalizedName = normalizeSymbolName(definition.kind, definition.name);
    if (normalizedName.length === 0) {
        return;
    }
    const top = resolver.scopes[resolver.scopes.length - 1];
    if (!top) {
        return;
    }
    mapForKind(top, definition.kind).set(normalizedName, {
        ...definition,
        name: normalizedName
    });
}
export function resolveSemanticSymbol(resolver, kind, name, consumerStatementId) {
    const normalizedName = normalizeSymbolName(kind, name);
    if (normalizedName.length === 0) {
        return null;
    }
    let resolved = null;
    for (let index = resolver.scopes.length - 1; index >= 0; index -= 1) {
        const frame = resolver.scopes[index];
        if (!frame) {
            continue;
        }
        const candidate = mapForKind(frame, kind).get(normalizedName);
        if (candidate) {
            resolved = candidate;
            break;
        }
    }
    if (!consumerStatementId) {
        return resolved;
    }
    if (resolved) {
        const edge = {
            consumerStatementId,
            providerStatementId: resolved.statementId,
            kind,
            name: normalizedName
        };
        const key = `${edge.consumerStatementId}\u0000${edge.providerStatementId}\u0000${edge.kind}\u0000${edge.name}`;
        resolver.dependencyEdges.set(key, edge);
    }
    else {
        const unresolved = {
            consumerStatementId,
            kind,
            name: normalizedName
        };
        const key = `${unresolved.consumerStatementId}\u0000${unresolved.kind}\u0000${unresolved.name}`;
        resolver.unresolvedSymbols.set(key, unresolved);
    }
    return resolved;
}
export function requireSemanticLibrary(resolver, libraryName, consumerStatementId) {
    const normalized = normalizeSymbolName("library", libraryName);
    if (normalized.length === 0) {
        return;
    }
    resolver.requiredLibraries.add(normalized);
    void resolveSemanticSymbol(resolver, "library", normalized, consumerStatementId);
}
export function exportSemanticSymbolResolverState(resolver) {
    return {
        scopes: resolver.scopes.map((scope) => ({
            macro: new Map(scope.macro),
            color: new Map(scope.color),
            style: new Map(scope.style),
            key: new Map(scope.key),
            library: new Map(scope.library)
        })),
        dependencyEdges: [...resolver.dependencyEdges.values()],
        unresolvedSymbols: [...resolver.unresolvedSymbols.values()],
        requiredLibraries: [...resolver.requiredLibraries].sort((left, right) => left.localeCompare(right))
    };
}
export function importSemanticSymbolResolverState(resolver, state) {
    resolver.scopes = state.scopes.map((scope) => ({
        macro: new Map(scope.macro),
        color: new Map(scope.color),
        style: new Map(scope.style),
        key: new Map(scope.key),
        library: new Map(scope.library)
    }));
    if (resolver.scopes.length === 0) {
        resolver.scopes = [createScopeFrame()];
    }
    resolver.dependencyEdges = new Map(state.dependencyEdges.map((edge) => [
        `${edge.consumerStatementId}\u0000${edge.providerStatementId}\u0000${edge.kind}\u0000${edge.name}`,
        edge
    ]));
    resolver.unresolvedSymbols = new Map(state.unresolvedSymbols.map((entry) => [
        `${entry.consumerStatementId}\u0000${entry.kind}\u0000${entry.name}`,
        entry
    ]));
    resolver.requiredLibraries = new Set(state.requiredLibraries);
}
