import { PersistentMap } from "./persistent-map.js";
const GEOMETRY_CATEGORY = "geometry";
export class SemanticDependencyGraphBuilder {
    sourceNodes = new PersistentMap();
    resourceNodes = new PersistentMap();
    edges = new PersistentMap();
    ensureSourceNode(sourceId) {
        const existing = this.sourceNodes.get(sourceId);
        if (!existing) {
            this.sourceNodes.set(sourceId, {
                sourceId,
                opaqueReasons: new Set()
            });
        }
        return sourceNodeId(sourceId);
    }
    ensureResourceNode(kind, key) {
        const resourceNodeKey = resourceNodeId(kind, key);
        const existing = this.resourceNodes.get(resourceNodeKey);
        if (!existing) {
            this.resourceNodes.set(resourceNodeKey, {
                resourceKind: kind,
                resourceKey: key
            });
        }
        return resourceNodeKey;
    }
    addProducer(sourceId, resourceKind, resourceKey) {
        const sourceIdNode = this.ensureSourceNode(sourceId);
        const resourceIdNode = this.ensureResourceNode(resourceKind, resourceKey);
        this.addEdge({
            from: sourceIdNode,
            to: resourceIdNode,
            category: GEOMETRY_CATEGORY,
            relation: "producer"
        });
    }
    addConsumer(sourceId, resourceKind, resourceKey) {
        const sourceIdNode = this.ensureSourceNode(sourceId);
        const resourceIdNode = this.ensureResourceNode(resourceKind, resourceKey);
        this.addEdge({
            from: resourceIdNode,
            to: sourceIdNode,
            category: GEOMETRY_CATEGORY,
            relation: "consumer"
        });
    }
    markSourceOpaque(sourceId, reason) {
        const sourceNode = this.sourceNodes.get(sourceId);
        if (!sourceNode) {
            this.sourceNodes.set(sourceId, {
                sourceId,
                opaqueReasons: new Set([reason])
            });
            return;
        }
        if (sourceNode.opaqueReasons.has(reason)) {
            return;
        }
        const nextOpaqueReasons = new Set(sourceNode.opaqueReasons);
        nextOpaqueReasons.add(reason);
        this.sourceNodes.set(sourceId, {
            ...sourceNode,
            opaqueReasons: nextOpaqueReasons
        });
    }
    build() {
        const nodes = [];
        for (const sourceNode of this.sourceNodes.values()) {
            const opaqueReasons = [...sourceNode.opaqueReasons].sort();
            nodes.push({
                id: sourceNodeId(sourceNode.sourceId),
                kind: "source",
                sourceId: sourceNode.sourceId,
                opaque: opaqueReasons.length > 0,
                opaqueReasons
            });
        }
        for (const [id, resourceNode] of this.resourceNodes) {
            nodes.push({
                id,
                kind: "resource",
                resourceKind: resourceNode.resourceKind,
                resourceKey: resourceNode.resourceKey
            });
        }
        nodes.sort((left, right) => left.id.localeCompare(right.id));
        const edges = [...this.edges.values()].sort(compareEdges);
        return {
            nodes,
            edges
        };
    }
    exportState() {
        return {
            sourceNodes: this.sourceNodes.snapshot(),
            resourceNodes: this.resourceNodes.snapshot(),
            edges: this.edges.snapshot()
        };
    }
    importState(state) {
        this.sourceNodes.restore(state.sourceNodes);
        this.resourceNodes.restore(state.resourceNodes);
        this.edges.restore(state.edges);
    }
    clone() {
        const cloned = new SemanticDependencyGraphBuilder();
        cloned.importState(this.exportState());
        return cloned;
    }
    addEdge(edge) {
        const edgeKey = `${edge.from}|${edge.to}|${edge.category}|${edge.relation}`;
        if (this.edges.has(edgeKey)) {
            return;
        }
        this.edges.set(edgeKey, edge);
    }
}
export function collectGeometryInvalidation(graph, query) {
    const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
    const adjacency = new Map();
    for (const edge of graph.edges) {
        if (edge.category !== GEOMETRY_CATEGORY) {
            continue;
        }
        const existing = adjacency.get(edge.from);
        if (existing) {
            existing.push(edge.to);
        }
        else {
            adjacency.set(edge.from, [edge.to]);
        }
    }
    const queue = [];
    const visited = new Set();
    for (const sourceId of new Set(query.changedSourceIds)) {
        const id = sourceNodeId(sourceId);
        if (!nodeById.has(id)) {
            continue;
        }
        if (visited.has(id)) {
            continue;
        }
        visited.add(id);
        queue.push(id);
    }
    const affectedSourceIds = new Set();
    const opaqueSourceIds = new Set();
    while (queue.length > 0) {
        const nextId = queue.shift();
        if (!nextId) {
            continue;
        }
        const node = nodeById.get(nextId);
        if (!node) {
            continue;
        }
        if (node.kind === "source") {
            affectedSourceIds.add(node.sourceId);
            if (node.opaque) {
                opaqueSourceIds.add(node.sourceId);
                continue;
            }
        }
        for (const neighbor of adjacency.get(nextId) ?? []) {
            if (visited.has(neighbor)) {
                continue;
            }
            visited.add(neighbor);
            queue.push(neighbor);
        }
    }
    const sortedAffectedSourceIds = [...affectedSourceIds].sort();
    const sortedOpaqueSourceIds = [...opaqueSourceIds].sort();
    return {
        affectedSourceIds: sortedAffectedSourceIds,
        opaqueSourceIds: sortedOpaqueSourceIds,
        reachedOpaque: sortedOpaqueSourceIds.length > 0
    };
}
function compareEdges(left, right) {
    if (left.from !== right.from) {
        return left.from.localeCompare(right.from);
    }
    if (left.to !== right.to) {
        return left.to.localeCompare(right.to);
    }
    return left.relation.localeCompare(right.relation);
}
export function sourceNodeId(sourceId) {
    return `source:${sourceId}`;
}
export function resourceNodeId(kind, resourceKey) {
    return `resource:${kind}:${resourceKey}`;
}
