import { parseLength } from "./coords/parse-length.js";
import { BACKGROUND_SCENE_LAYER, MAIN_SCENE_LAYER } from "./types.js";
import { createDefaultCustomStyleRegistry } from "./style/custom-styles.js";
import { createDefaultPicDefinitionRegistry } from "./pics/registry.js";
import { computeSourceFingerprint } from "../utils/source-fingerprint.js";
import { cloneResolvedStyle } from "./style-chain.js";
import { PersistentMap } from "./persistent-map.js";
import { SemanticDependencyGraphBuilder } from "./dependencies.js";
import { createSemanticSymbolResolver, defineSemanticSymbol, exportSemanticSymbolResolverState, requireSemanticLibrary, resolveSemanticSymbol, importSemanticSymbolResolverState, popSemanticSymbolScope, pushSemanticSymbolScope } from "./symbol-resolver.js";
import { createPgfRandom } from "./pgfmath/rng.js";
export function createSemanticContext(initialStyle, initialTransform, textEngine = null, source = "", sourceFingerprint = computeSourceFingerprint(source)) {
    const defaultNodeDistance = 28.4527559055;
    const defaultTreeDistance = 15 * 2.84527559055;
    const clonedStyle = cloneResolvedStyle(initialStyle);
    const defaultBackgroundState = createDefaultSemanticBackgroundState();
    const defaultGlobalSource = {
        sourceId: "__global__",
        sourceKind: "global-default",
        label: "TikZ defaults"
    };
    return {
        stack: [
            {
                style: clonedStyle,
                styleChain: [
                    {
                        kind: "global",
                        sourceRef: defaultGlobalSource,
                        rawOptions: [],
                        before: cloneResolvedStyle(clonedStyle),
                        after: cloneResolvedStyle(clonedStyle),
                        resolvedContributions: cloneResolvedStyle(clonedStyle)
                    }
                ],
                transform: initialTransform,
                layer: MAIN_SCENE_LAYER,
                clipChain: [],
                pictureSizeRelevant: true,
                customStyles: createDefaultCustomStyleRegistry(),
                picDefinitions: createDefaultPicDefinitionRegistry(),
                colorAliases: new Map(),
                macroBindings: new Map(),
                namePrefix: "",
                nameSuffix: "",
                nodeLayerMode: "front",
                onGrid: false,
                nodeDistance: {
                    kind: "pair",
                    vertical: { kind: "dimension", value: defaultNodeDistance },
                    horizontal: { kind: "dimension", value: defaultNodeDistance }
                },
                nodeQuotesMode: "label",
                labelPosition: "above",
                pinPosition: "above",
                labelDistancePt: 0,
                pinDistancePt: 12.9,
                pinEdgeRaw: null,
                transformShape: false,
                everyNodeStyles: [],
                everyTextNodePartStyles: [],
                everyFitStyles: [],
                everyPicStyles: [],
                everyRectangleNodeStyles: [],
                everyCircleNodeStyles: [],
                everyDiamondNodeStyles: [],
                everyTrapeziumNodeStyles: [],
                everyIsoscelesTriangleNodeStyles: [],
                everyKiteNodeStyles: [],
                everyDartNodeStyles: [],
                everyCircularSectorNodeStyles: [],
                everyCylinderNodeStyles: [],
                everyCloudNodeStyles: [],
                everyStarburstNodeStyles: [],
                everySignalNodeStyles: [],
                everyTapeNodeStyles: [],
                everyRectangleCalloutNodeStyles: [],
                everyEllipseCalloutNodeStyles: [],
                everyCloudCalloutNodeStyles: [],
                everySingleArrowNodeStyles: [],
                everyDoubleArrowNodeStyles: [],
                treeLevel: 0,
                treeLevelDistancePt: defaultTreeDistance,
                treeSiblingDistancePt: defaultTreeDistance,
                treeCurrentLevelSiblingDistancePt: null,
                treeGrowDirectionDegrees: -90,
                treeGrowReverse: false,
                treeGrowthParentAnchor: "center",
                treeParentAnchor: "border",
                treeChildAnchor: "border",
                treeMissing: false,
                treeEveryChildStyles: [],
                treeEveryChildNodeStyles: [],
                treeLevelStyleTemplateLayers: [],
                treeLevelStyleLayers: [],
                treeDeferredGrowthFunction: false,
                treeDeferredEdgeFromParentPath: false,
                treeDeferredEdgeFromParentMacro: false
            }
        ],
        source,
        sourceFingerprint,
        layers: createDefaultSceneLayerMap(),
        backgroundState: defaultBackgroundState,
        pictureBounds: null,
        namedCoordinates: new PersistentMap(),
        namedNodeSets: new PersistentMap(),
        namedCoordinateRewriteHandles: new PersistentMap(),
        namedNodeGeometries: new PersistentMap(),
        namedPaths: new PersistentMap(),
        currentPoint: null,
        pathStartPoint: null,
        textEngine,
        macroTraceCollector: null,
        picEvaluationStack: [],
        editHandles: [],
        dependencyBuilder: new SemanticDependencyGraphBuilder(),
        dependencyActiveSourceId: null,
        statementEffectTracker: null,
        symbolResolver: createSemanticSymbolResolver(),
        mathRandom: createPgfRandom(1)
    };
}
export function createDefaultSemanticBackgroundState() {
    return {
        used: false,
        innerFrameXSep: parseLength("1ex", "pt") ?? 4.3,
        innerFrameYSep: parseLength("1ex", "pt") ?? 4.3,
        outerFrameXSep: 0,
        outerFrameYSep: 0,
        hooks: [],
        nextHookSequence: 0
    };
}
function createDefaultSceneLayerMap() {
    return new Map([[MAIN_SCENE_LAYER, { name: MAIN_SCENE_LAYER, order: 0 }]]);
}
export function markBackgroundLayerUsed(context) {
    context.backgroundState.used = true;
    context.layers.set(BACKGROUND_SCENE_LAYER, { name: BACKGROUND_SCENE_LAYER, order: 0 });
    context.layers.set(MAIN_SCENE_LAYER, { name: MAIN_SCENE_LAYER, order: 1 });
}
export function listContextSceneLayers(context) {
    return [...context.layers.values()].sort((left, right) => {
        if (left.order !== right.order) {
            return left.order - right.order;
        }
        return left.name.localeCompare(right.name);
    });
}
export function currentFrame(context) {
    return context.stack[context.stack.length - 1];
}
export function pushFrame(context, frame) {
    context.stack.push(frame);
    pushSemanticSymbolScope(context.symbolResolver);
}
export function popFrame(context) {
    if (context.stack.length > 1) {
        context.stack.pop();
        popSemanticSymbolScope(context.symbolResolver);
    }
}
export function snapshotSemanticContext(context, options = {}) {
    const editHandlesMode = options.editHandlesMode ?? "clone";
    return {
        stack: structuredClone(context.stack),
        layers: listContextSceneLayers(context),
        backgroundState: structuredClone(context.backgroundState),
        pictureBounds: context.pictureBounds ? { ...context.pictureBounds } : null,
        namedCoordinatesState: context.namedCoordinates.snapshot(),
        namedNodeSetsState: context.namedNodeSets.snapshot(),
        namedCoordinateRewriteHandlesState: context.namedCoordinateRewriteHandles.snapshot(),
        namedNodeGeometriesState: context.namedNodeGeometries.snapshot(),
        namedPathsState: context.namedPaths.snapshot(),
        currentPoint: context.currentPoint ? { ...context.currentPoint } : null,
        pathStartPoint: context.pathStartPoint ? { ...context.pathStartPoint } : null,
        editHandles: editHandlesMode === "clone" ? structuredClone(context.editHandles) : null,
        editHandlesLength: context.editHandles.length,
        dependencyBuilderState: context.dependencyBuilder.exportState(),
        dependencyActiveSourceId: context.dependencyActiveSourceId,
        symbolResolverState: exportSemanticSymbolResolverState(context.symbolResolver),
        mathRandomSeed: context.mathRandom.getSeed()
    };
}
export function restoreSemanticContext(context, snapshot, options = {}) {
    context.stack = structuredClone(snapshot.stack);
    context.layers = new Map(snapshot.layers.map((layer) => [layer.name, { ...layer }]));
    context.backgroundState = structuredClone(snapshot.backgroundState);
    context.pictureBounds = snapshot.pictureBounds ? { ...snapshot.pictureBounds } : null;
    context.namedCoordinates.restore(snapshot.namedCoordinatesState);
    context.namedNodeSets.restore(snapshot.namedNodeSetsState);
    context.namedCoordinateRewriteHandles.restore(snapshot.namedCoordinateRewriteHandlesState);
    context.namedNodeGeometries.restore(snapshot.namedNodeGeometriesState);
    context.namedPaths.restore(snapshot.namedPathsState);
    context.currentPoint = snapshot.currentPoint ? { ...snapshot.currentPoint } : null;
    context.pathStartPoint = snapshot.pathStartPoint ? { ...snapshot.pathStartPoint } : null;
    if (snapshot.editHandles) {
        context.editHandles = snapshot.editHandles.slice();
    }
    else {
        const source = options.editHandleSource;
        if (!source || snapshot.editHandlesLength > source.length) {
            throw new Error("Missing edit handle source for compact semantic context restore");
        }
        context.editHandles = source.slice(0, snapshot.editHandlesLength);
    }
    context.dependencyBuilder.importState(snapshot.dependencyBuilderState);
    context.dependencyActiveSourceId = snapshot.dependencyActiveSourceId;
    importSemanticSymbolResolverState(context.symbolResolver, snapshot.symbolResolverState);
    context.mathRandom.setSeed(snapshot.mathRandomSeed);
    context.statementEffectTracker = null;
}
export function retargetEditHandlesSourceFingerprint(handles, sourceFingerprint) {
    for (let index = 0; index < handles.length; index += 1) {
        const handle = handles[index];
        if (!handle || handle.sourceRef.sourceFingerprint === sourceFingerprint) {
            continue;
        }
        handles[index] = {
            ...handle,
            sourceRef: {
                ...handle.sourceRef,
                sourceFingerprint
            }
        };
    }
}
export function withDependencySource(context, sourceId, fn) {
    const previous = context.dependencyActiveSourceId;
    context.dependencyBuilder.ensureSourceNode(sourceId);
    context.dependencyActiveSourceId = sourceId;
    try {
        return fn();
    }
    finally {
        context.dependencyActiveSourceId = previous;
    }
}
export function defineContextSymbol(context, definition) {
    defineSemanticSymbol(context.symbolResolver, definition);
}
export function resolveContextSymbol(context, kind, name, explicitConsumerStatementId) {
    const consumerStatementId = explicitConsumerStatementId ?? context.dependencyActiveSourceId ?? null;
    return resolveSemanticSymbol(context.symbolResolver, kind, name, consumerStatementId);
}
export function requireContextLibrary(context, libraryName, explicitConsumerStatementId) {
    const consumerStatementId = explicitConsumerStatementId ?? context.dependencyActiveSourceId ?? null;
    requireSemanticLibrary(context.symbolResolver, libraryName, consumerStatementId);
}
export function listContextSymbolDependencyEdges(context) {
    return [...context.symbolResolver.dependencyEdges.values()].sort((left, right) => {
        if (left.consumerStatementId !== right.consumerStatementId) {
            return left.consumerStatementId.localeCompare(right.consumerStatementId);
        }
        if (left.providerStatementId !== right.providerStatementId) {
            return left.providerStatementId.localeCompare(right.providerStatementId);
        }
        if (left.kind !== right.kind) {
            return left.kind.localeCompare(right.kind);
        }
        return left.name.localeCompare(right.name);
    });
}
export function listContextUnresolvedSymbols(context) {
    return [...context.symbolResolver.unresolvedSymbols.values()].sort((left, right) => {
        if (left.consumerStatementId !== right.consumerStatementId) {
            return left.consumerStatementId.localeCompare(right.consumerStatementId);
        }
        if (left.kind !== right.kind) {
            return left.kind.localeCompare(right.kind);
        }
        return left.name.localeCompare(right.name);
    });
}
export function listContextRequiredLibraries(context) {
    return [...context.symbolResolver.requiredLibraries].sort((left, right) => left.localeCompare(right));
}
export function writeContextMacroBinding(context, name, binding, definition) {
    const frame = currentFrame(context);
    frame.macroBindings.set(name, binding);
    if (definition) {
        defineContextSymbol(context, {
            kind: "macro",
            name,
            statementId: definition.statementId,
            span: definition.span
        });
    }
}
export function readContextMacroBinding(context, name, explicitConsumerStatementId) {
    void resolveContextSymbol(context, "macro", name, explicitConsumerStatementId);
    const frame = currentFrame(context);
    return frame.macroBindings.get(name);
}
export function deleteContextMacroBinding(context, name) {
    const frame = currentFrame(context);
    frame.macroBindings.delete(name);
}
export function writeContextColorAlias(context, name, value, definition) {
    const normalized = normalizeColorAliasKey(name);
    if (!normalized) {
        return;
    }
    const frame = currentFrame(context);
    frame.colorAliases.set(normalized, value);
    if (definition) {
        defineContextSymbol(context, {
            kind: "color",
            name: normalized,
            statementId: definition.statementId,
            span: definition.span
        });
    }
}
export function resolveContextColorAliasValue(context, rawColorName, explicitConsumerStatementId) {
    const initialKey = normalizeColorAliasKey(rawColorName);
    if (!initialKey) {
        return null;
    }
    const consumerStatementId = explicitConsumerStatementId ?? context.dependencyActiveSourceId ?? null;
    const frame = currentFrame(context);
    if (!frame.colorAliases.has(initialKey)) {
        return null;
    }
    void resolveContextSymbol(context, "color", initialKey, consumerStatementId);
    let resolved = frame.colorAliases.get(initialKey);
    if (!resolved) {
        return null;
    }
    const seen = new Set([initialKey]);
    while (true) {
        const nextKey = normalizeColorAliasKey(resolved);
        if (!nextKey || seen.has(nextKey)) {
            break;
        }
        if (!frame.colorAliases.has(nextKey)) {
            break;
        }
        void resolveContextSymbol(context, "color", nextKey, consumerStatementId);
        const nextResolved = frame.colorAliases.get(nextKey);
        if (!nextResolved) {
            break;
        }
        seen.add(nextKey);
        resolved = nextResolved;
    }
    return resolved;
}
function normalizeColorAliasKey(raw) {
    const trimmed = raw.trim().toLowerCase();
    if (trimmed.length === 0) {
        return null;
    }
    return trimmed;
}
export function recordDependencyProducer(context, resourceKind, resourceKey, explicitSourceId) {
    const sourceId = explicitSourceId ?? context.dependencyActiveSourceId;
    if (!sourceId) {
        return;
    }
    const tracker = context.statementEffectTracker;
    if (tracker) {
        if (resourceKind === "named-path") {
            tracker.producedNamedPaths.add(resourceKey);
        }
    }
    context.dependencyBuilder.addProducer(sourceId, resourceKind, resourceKey);
}
export function recordDependencyConsumer(context, resourceKind, resourceKey, explicitSourceId) {
    const sourceId = explicitSourceId ?? context.dependencyActiveSourceId;
    if (!sourceId) {
        return;
    }
    const tracker = context.statementEffectTracker;
    if (tracker) {
        tracker.consumedNamedResources.set(`${resourceKind}\u0000${resourceKey}`, {
            kind: resourceKind,
            key: resourceKey
        });
    }
    context.dependencyBuilder.addConsumer(sourceId, resourceKind, resourceKey);
}
export function markDependencyOpaque(context, sourceId, reason) {
    const tracker = context.statementEffectTracker;
    if (tracker && (context.dependencyActiveSourceId == null || context.dependencyActiveSourceId === sourceId)) {
        tracker.opaqueReasons.add(reason);
    }
    context.dependencyBuilder.markSourceOpaque(sourceId, reason);
}
export function writeNamedCoordinate(context, name, point, explicitSourceId) {
    context.namedCoordinates.set(name, point);
    const tracker = context.statementEffectTracker;
    if (tracker) {
        tracker.producedNamedCoordinates.set(name, { ...point });
    }
    recordDependencyProducer(context, "named-coordinate", name, explicitSourceId);
}
export function readNamedCoordinate(context, name, explicitSourceId) {
    const point = context.namedCoordinates.get(name);
    if (point != null) {
        recordDependencyConsumer(context, "named-coordinate", name, explicitSourceId);
    }
    return point;
}
export function writeNamedNodeGeometry(context, name, geometry, explicitSourceId) {
    context.namedNodeGeometries.set(name, geometry);
    const tracker = context.statementEffectTracker;
    if (tracker) {
        tracker.producedNamedNodeGeometries.set(name, structuredClone(geometry));
    }
    recordDependencyProducer(context, "named-node-geometry", name, explicitSourceId);
}
export function readNamedNodeGeometry(context, name, explicitSourceId) {
    const geometry = context.namedNodeGeometries.get(name);
    if (geometry != null) {
        recordDependencyConsumer(context, "named-node-geometry", name, explicitSourceId);
    }
    return geometry;
}
export function appendNamedPathElements(context, name, elements, producerSourceIds) {
    const existing = context.namedPaths.get(name) ?? [];
    context.namedPaths.set(name, [...existing, ...elements]);
    const tracker = context.statementEffectTracker;
    if (tracker) {
        tracker.producedNamedPaths.add(name);
    }
    for (const sourceId of producerSourceIds) {
        context.dependencyBuilder.addProducer(sourceId, "named-path", name);
    }
}
export function readNamedPath(context, name, explicitSourceId) {
    const elements = context.namedPaths.get(name);
    if (elements != null) {
        recordDependencyConsumer(context, "named-path", name, explicitSourceId);
    }
    return elements;
}
export function beginStatementEffectTracking(context) {
    context.statementEffectTracker = {
        producedNamedCoordinates: new Map(),
        producedNamedNodeGeometries: new Map(),
        producedNamedPaths: new Set(),
        consumedNamedResources: new Map(),
        opaqueReasons: new Set()
    };
}
export function endStatementEffectTracking(context, options) {
    const tracker = context.statementEffectTracker;
    context.statementEffectTracker = null;
    if (!tracker) {
        return {
            producesNamedCoordinates: [],
            producesNamedNodeGeometries: [],
            producesNamedPaths: [],
            consumesNamedResources: [],
            mutatesCurrentPoint: pointsDiffer(options.beforeCurrentPoint, context.currentPoint),
            nextCurrentPoint: context.currentPoint ? { ...context.currentPoint } : null,
            mutatesPathStartPoint: pointsDiffer(options.beforePathStartPoint, context.pathStartPoint),
            nextPathStartPoint: context.pathStartPoint ? { ...context.pathStartPoint } : null,
            requiresSequentialContext: options.requiresSequentialContext,
            suffixSkipKind: "unsafe",
            opaque: false,
            opaqueReasons: []
        };
    }
    return {
        producesNamedCoordinates: [...tracker.producedNamedCoordinates.entries()].map(([key, point]) => ({
            key,
            point: { ...point }
        })),
        producesNamedNodeGeometries: [...tracker.producedNamedNodeGeometries.entries()].map(([key, geometry]) => ({
            key,
            geometry: structuredClone(geometry)
        })),
        producesNamedPaths: [...tracker.producedNamedPaths],
        consumesNamedResources: [...tracker.consumedNamedResources.values()].sort((left, right) => {
            const leftKey = `${left.kind}\u0000${left.key}`;
            const rightKey = `${right.kind}\u0000${right.key}`;
            return leftKey.localeCompare(rightKey);
        }),
        mutatesCurrentPoint: pointsDiffer(options.beforeCurrentPoint, context.currentPoint),
        nextCurrentPoint: context.currentPoint ? { ...context.currentPoint } : null,
        mutatesPathStartPoint: pointsDiffer(options.beforePathStartPoint, context.pathStartPoint),
        nextPathStartPoint: context.pathStartPoint ? { ...context.pathStartPoint } : null,
        requiresSequentialContext: options.requiresSequentialContext,
        suffixSkipKind: "unsafe",
        opaque: tracker.opaqueReasons.size > 0,
        opaqueReasons: [...tracker.opaqueReasons].sort()
    };
}
export function applyStatementEffectSummary(context, summary, options = {}) {
    const sourceId = options.sourceId;
    if (sourceId) {
        context.dependencyBuilder.ensureSourceNode(sourceId);
    }
    for (const produced of summary.producesNamedCoordinates) {
        context.namedCoordinates.set(produced.key, { ...produced.point });
        recordDependencyProducer(context, "named-coordinate", produced.key, sourceId);
    }
    for (const produced of summary.producesNamedNodeGeometries) {
        context.namedNodeGeometries.set(produced.key, structuredClone(produced.geometry));
        recordDependencyProducer(context, "named-node-geometry", produced.key, sourceId);
    }
    for (const producedPath of summary.producesNamedPaths) {
        recordDependencyProducer(context, "named-path", producedPath, sourceId);
    }
    for (const consumed of summary.consumesNamedResources) {
        recordDependencyConsumer(context, consumed.kind, consumed.key, sourceId);
    }
    if (sourceId) {
        for (const reason of summary.opaqueReasons) {
            markDependencyOpaque(context, sourceId, reason);
        }
    }
    context.currentPoint = summary.nextCurrentPoint ? { ...summary.nextCurrentPoint } : null;
    context.pathStartPoint = summary.nextPathStartPoint ? { ...summary.nextPathStartPoint } : null;
}
function pointsDiffer(left, right) {
    if (left == null || right == null) {
        return left !== right;
    }
    return left.x !== right.x || left.y !== right.y;
}
