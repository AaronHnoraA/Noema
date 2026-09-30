import type { PersistentMapSnapshot } from "./persistent-map.js";
export type SemanticDependencyCategory = "geometry";
export type SemanticDependencyNodeKind = "source" | "resource";
export type SemanticDependencyResourceKind = "named-coordinate" | "named-node-geometry" | "named-path";
export type SemanticDependencyOpaqueReason = "foreach-origin" | "macro-origin";
export type SemanticDependencySourceNode = {
    id: string;
    kind: "source";
    sourceId: string;
    opaque: boolean;
    opaqueReasons: SemanticDependencyOpaqueReason[];
};
export type SemanticDependencyResourceNode = {
    id: string;
    kind: "resource";
    resourceKind: SemanticDependencyResourceKind;
    resourceKey: string;
};
export type SemanticDependencyNode = SemanticDependencySourceNode | SemanticDependencyResourceNode;
export type SemanticDependencyRelation = "producer" | "consumer";
export type SemanticDependencyEdge = {
    from: string;
    to: string;
    category: SemanticDependencyCategory;
    relation: SemanticDependencyRelation;
};
export type SemanticDependencyGraph = {
    nodes: SemanticDependencyNode[];
    edges: SemanticDependencyEdge[];
};
export type GeometryInvalidationQuery = {
    changedSourceIds: readonly string[];
};
export type GeometryInvalidationResult = {
    affectedSourceIds: string[];
    opaqueSourceIds: string[];
    reachedOpaque: boolean;
};
export type SemanticDependencyGraphBuilderState = {
    sourceNodes: PersistentMapSnapshot<string, SourceNodeState>;
    resourceNodes: PersistentMapSnapshot<string, ResourceNodeState>;
    edges: PersistentMapSnapshot<string, SemanticDependencyEdge>;
};
type SourceNodeState = {
    sourceId: string;
    opaqueReasons: ReadonlySet<SemanticDependencyOpaqueReason>;
};
type ResourceNodeState = {
    resourceKind: SemanticDependencyResourceKind;
    resourceKey: string;
};
export declare class SemanticDependencyGraphBuilder {
    private sourceNodes;
    private resourceNodes;
    private edges;
    ensureSourceNode(sourceId: string): string;
    ensureResourceNode(kind: SemanticDependencyResourceKind, key: string): string;
    addProducer(sourceId: string, resourceKind: SemanticDependencyResourceKind, resourceKey: string): void;
    addConsumer(sourceId: string, resourceKind: SemanticDependencyResourceKind, resourceKey: string): void;
    markSourceOpaque(sourceId: string, reason: SemanticDependencyOpaqueReason): void;
    build(): SemanticDependencyGraph;
    exportState(): SemanticDependencyGraphBuilderState;
    importState(state: SemanticDependencyGraphBuilderState): void;
    clone(): SemanticDependencyGraphBuilder;
    private addEdge;
}
export declare function collectGeometryInvalidation(graph: SemanticDependencyGraph, query: GeometryInvalidationQuery): GeometryInvalidationResult;
export declare function sourceNodeId(sourceId: string): string;
export declare function resourceNodeId(kind: SemanticDependencyResourceKind, resourceKey: string): string;
export {};
