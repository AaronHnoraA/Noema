import type { Span } from "../ast/types.js";
export type SemanticSymbolKind = "macro" | "color" | "style" | "key" | "library";
export type SemanticSymbolDefinition = {
    kind: SemanticSymbolKind;
    name: string;
    statementId: string;
    span: Span;
};
export type SemanticSymbolDependencyEdge = {
    consumerStatementId: string;
    providerStatementId: string;
    kind: SemanticSymbolKind;
    name: string;
};
export type SemanticUnresolvedSymbol = {
    consumerStatementId: string;
    kind: SemanticSymbolKind;
    name: string;
};
type SemanticSymbolScopeFrame = {
    macro: Map<string, SemanticSymbolDefinition>;
    color: Map<string, SemanticSymbolDefinition>;
    style: Map<string, SemanticSymbolDefinition>;
    key: Map<string, SemanticSymbolDefinition>;
    library: Map<string, SemanticSymbolDefinition>;
};
export type SemanticSymbolResolverState = {
    scopes: SemanticSymbolScopeFrame[];
    dependencyEdges: SemanticSymbolDependencyEdge[];
    unresolvedSymbols: SemanticUnresolvedSymbol[];
    requiredLibraries: string[];
};
export type SemanticSymbolResolver = {
    scopes: SemanticSymbolScopeFrame[];
    dependencyEdges: Map<string, SemanticSymbolDependencyEdge>;
    unresolvedSymbols: Map<string, SemanticUnresolvedSymbol>;
    requiredLibraries: Set<string>;
};
export declare function createSemanticSymbolResolver(): SemanticSymbolResolver;
export declare function pushSemanticSymbolScope(resolver: SemanticSymbolResolver): void;
export declare function popSemanticSymbolScope(resolver: SemanticSymbolResolver): void;
export declare function defineSemanticSymbol(resolver: SemanticSymbolResolver, definition: SemanticSymbolDefinition): void;
export declare function resolveSemanticSymbol(resolver: SemanticSymbolResolver, kind: SemanticSymbolKind, name: string, consumerStatementId: string | null): SemanticSymbolDefinition | null;
export declare function requireSemanticLibrary(resolver: SemanticSymbolResolver, libraryName: string, consumerStatementId: string | null): void;
export declare function exportSemanticSymbolResolverState(resolver: SemanticSymbolResolver): SemanticSymbolResolverState;
export declare function importSemanticSymbolResolverState(resolver: SemanticSymbolResolver, state: SemanticSymbolResolverState): void;
export {};
