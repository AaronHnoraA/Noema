import { pt } from "../../coords/scalars.js";
import { frameTransform, worldTransform } from "../../coords/transforms.js";
import { worldPoint } from "../../coords/points.js";
import { evaluateTikzFigure } from "../../semantic/evaluate.js";
import { isFrameLocalCoordinateEditHandle } from "../../semantic/types.js";
import { applyTextReplacements } from "../statement-ops.js";
import { rewriteCoordinate } from "../rewrite.js";
import { CM_PER_PT, formatNumber } from "../format.js";
import { normalizeOptionKey } from "../option-mutations.js";
import { applyOptionMutationsToTarget } from "../option-mutations.js";
import { resolvePropertyTarget } from "../property-target.js";
import { parseTikzForEdit } from "../parse-options.js";
import { buildTransformSetPropertyMutations, resolveTransformInspectorMutationContextFromOptionEntries, ROTATE_CLEAR_KEYS } from "../property-write-builders.js";
import { findPathStatementById } from "../statement-find.js";
const ROTATE_EPSILON = 1e-6;
export function applyRotateElementAction(currentSource, action, evaluateOptions, parseOptions = {}) {
    const elementId = action.elementId.trim();
    if (elementId.length === 0) {
        return { kind: "unsupported", reason: "Missing element id for rotateElement." };
    }
    if (!Number.isFinite(action.angleDeg)) {
        return { kind: "unsupported", reason: "Missing rotate angle." };
    }
    const baselineSource = action.baselineSource ?? currentSource;
    const result = action.mode === "center-pivot"
        ? applyCenterPivotRotate(baselineSource, action, evaluateOptions, parseOptions)
        : applyPropertyRotate(baselineSource, action, parseOptions);
    if (result.kind === "success" && baselineSource !== currentSource) {
        return {
            ...result,
            patches: [computeReplacementPatch(currentSource, result.newSource)]
        };
    }
    return result;
}
function applyPropertyRotate(source, action, parseOptions) {
    const targetId = (action.targetId ?? action.elementId).trim();
    const resolvedTarget = resolvePropertyTarget(source, targetId, parseOptions);
    if (resolvedTarget.kind !== "found") {
        return { kind: "unsupported", reason: resolvedTarget.reason };
    }
    const context = resolveTransformInspectorMutationContextFromOptionEntries(resolvedTarget.target.options?.entries);
    const mutations = action.mode === "origin"
        ? buildOriginRotateMutations(action.angleDeg)
        : buildPropertyRotateMutations(context, action.angleDeg);
    const applied = applyOptionMutationsToTarget(source, resolvedTarget.target, mutations);
    if (!applied) {
        return { kind: "unsupported", reason: "rotateElement would not change the source." };
    }
    return {
        kind: "success",
        newSource: applied.source,
        patches: [applied.patch],
        changedSourceIds: [action.elementId]
    };
}
function applyCenterPivotRotate(source, action, evaluateOptions, parseOptions) {
    const baseline = buildBaselineContext(source, evaluateOptions, parseOptions);
    const context = resolveCenterPivotRotateContext(baseline.parsed.figure.body, baseline.semantic.scene.elements, baseline.semantic.editHandles, action.elementId);
    if (context.kind === "unsupported") {
        return context;
    }
    if (context.kind === "not-found") {
        return {
            kind: "unsupported",
            reason: "Center-pivot rotate currently supports explicit path rectangles, circles, and ellipses."
        };
    }
    if (pathHasUnsupportedTransformOptions(context.target)) {
        return {
            kind: "unsupported",
            reason: "Center-pivot rotate currently supports shapes without other path transforms."
        };
    }
    const targetId = (action.targetId ?? action.elementId).trim();
    const resolvedTarget = resolvePropertyTarget(source, targetId, parseOptions);
    if (resolvedTarget.kind !== "found") {
        return { kind: "unsupported", reason: resolvedTarget.reason };
    }
    const transformContext = resolveTransformInspectorMutationContextFromOptionEntries(resolvedTarget.target.options?.entries);
    const baseAngleDeg = transformContext.values.rotate;
    const pivot = resolveCenterPivot(context);
    const deltaDeg = normalizeSignedDeg(action.angleDeg - baseAngleDeg);
    const nextTransform = rotateAroundFrameTransform(action.angleDeg, pivot);
    const rotateMutation = buildCenterPivotRotateMutations(action.angleDeg, pivot);
    const coordinateRewrites = context.kind === "rectangle"
        ? buildRectangleCoordinateRewrites(source, context, pivot, deltaDeg, nextTransform)
        : buildEllipseLikeCoordinateRewrites(source, context, nextTransform);
    if (coordinateRewrites.kind === "unsupported") {
        return coordinateRewrites;
    }
    let nextSource = source;
    const patches = [];
    const optionApplied = applyOptionMutationsToTarget(nextSource, resolvedTarget.target, rotateMutation);
    if (optionApplied) {
        nextSource = optionApplied.source;
        patches.push(optionApplied.patch);
    }
    if (coordinateRewrites.replacements.length > 0) {
        const adjustedReplacements = adjustReplacementsForPriorPatches(coordinateRewrites.replacements, patches);
        const coordinateApplied = applyTextReplacements(nextSource, adjustedReplacements);
        nextSource = coordinateApplied.source;
        patches.push(...coordinateApplied.patches);
    }
    if (nextSource === source) {
        return { kind: "unsupported", reason: "rotateElement would not change the source." };
    }
    return {
        kind: "success",
        newSource: nextSource,
        patches,
        changedSourceIds: [action.elementId]
    };
}
function buildBaselineContext(source, evaluateOptions, parseOptions) {
    const parsed = parseTikzForEdit(source, { ...parseOptions });
    const semantic = evaluateTikzFigure(parsed.figure, source, evaluateOptions);
    return { source, parsed, semantic };
}
function buildPropertyRotateMutations(context, angleDeg) {
    return transformMutationsToOptionMutations(buildTransformSetPropertyMutations(context, "rotate", angleDeg));
}
function buildOriginRotateMutations(angleDeg) {
    const normalizedAngle = normalizeTinyNumber(angleDeg);
    const mutations = new Map();
    for (const key of ROTATE_CLEAR_KEYS) {
        mutations.set(key, { kind: "remove" });
    }
    if (Math.abs(normalizedAngle) <= ROTATE_EPSILON) {
        mutations.set("rotate", { kind: "remove" });
    }
    else {
        mutations.set("rotate", { kind: "set", value: formatNumber(normalizedAngle) });
    }
    return mutations;
}
function buildCenterPivotRotateMutations(angleDeg, pivot) {
    const normalizedAngle = normalizeTinyNumber(angleDeg);
    const mutations = new Map();
    for (const key of ROTATE_CLEAR_KEYS) {
        mutations.set(key, { kind: "remove" });
    }
    mutations.set("rotate", { kind: "remove" });
    if (Math.abs(normalizedAngle) <= ROTATE_EPSILON) {
        mutations.set("rotate around", { kind: "remove" });
    }
    else {
        mutations.set("rotate around", {
            kind: "set",
            value: `{${formatNumber(normalizedAngle)}:${formatWorldPointCoordinateRaw(pivot)}}`
        });
    }
    return mutations;
}
function transformMutationsToOptionMutations(transformMutations) {
    const mutations = new Map();
    for (const mutation of transformMutations) {
        for (const clearKey of mutation.clearKeys) {
            mutations.set(clearKey, { kind: "remove" });
        }
        mutations.set(mutation.key, mutation.value.length > 0 ? { kind: "set", value: mutation.value } : { kind: "remove" });
    }
    return mutations;
}
function resolveCenterPivotRotateContext(statements, elements, editHandles, elementId) {
    const pathStatement = findPathStatementById(statements, elementId);
    if (!pathStatement) {
        return { kind: "not-found" };
    }
    const sourceElements = elements.filter((element) => element.sourceRef.sourceId === elementId && !element.adornment);
    const nonTextElements = sourceElements.filter((element) => element.kind !== "Text");
    if (nonTextElements.length !== 1) {
        return { kind: "not-found" };
    }
    const element = nonTextElements[0];
    if (!element) {
        return { kind: "not-found" };
    }
    if (element.kind === "Path" && resolveScenePathShapeHint(element, pathStatement) === "rectangle") {
        const rectangle = resolveRectangleContext(pathStatement, editHandles, elementId);
        if (rectangle.kind !== "found") {
            return rectangle;
        }
        return {
            kind: "rectangle",
            target: pathStatement,
            startHandle: rectangle.startHandle,
            oppositeHandle: rectangle.oppositeHandle
        };
    }
    const shape = resolveEllipseLikeContext(pathStatement, element, editHandles, elementId);
    if (shape.kind !== "found") {
        return shape;
    }
    return {
        kind: shape.shapeKind,
        target: pathStatement,
        center: shape.center,
        centerHandle: shape.centerHandle
    };
}
function resolveRectangleContext(pathStatement, editHandles, elementId) {
    if (resolvePathShapeHintFromItems(pathStatement.items) !== "rectangle") {
        return { kind: "unsupported", reason: "Center-pivot rotate requires explicit path rectangles." };
    }
    const pathPointHandles = editHandles.filter((handle) => handle.sourceRef.sourceId === elementId && handle.kind === "path-point");
    if (pathPointHandles.length !== 2) {
        return { kind: "unsupported", reason: "Center-pivot rotate requires rectangles with explicit start and target coordinates." };
    }
    const [startHandle, oppositeHandle] = pathPointHandles;
    if (!startHandle || !oppositeHandle) {
        return { kind: "unsupported", reason: "Center-pivot rotate requires rectangles with explicit start and target coordinates." };
    }
    if (!isDirectFrameLocalHandle(startHandle) || !isDirectFrameLocalHandle(oppositeHandle)) {
        return { kind: "unsupported", reason: "Center-pivot rotate requires direct, rewritable rectangle coordinates." };
    }
    if (spansEqual(startHandle.sourceRef.sourceSpan, oppositeHandle.sourceRef.sourceSpan)) {
        return { kind: "unsupported", reason: "Center-pivot rotate cannot target shared coordinate spans." };
    }
    return { kind: "found", startHandle, oppositeHandle };
}
function resolveEllipseLikeContext(pathStatement, element, editHandles, elementId) {
    let shapeKind = null;
    let center = null;
    if (element.kind === "Circle") {
        shapeKind = "circle";
        center = element.center;
    }
    else if (element.kind === "Ellipse") {
        shapeKind = "ellipse";
        center = element.center;
    }
    else if (element.kind === "Path") {
        const hint = resolveScenePathShapeHint(element, pathStatement);
        if (hint === "circle" || hint === "ellipse") {
            shapeKind = hint;
        }
    }
    if (!shapeKind) {
        return { kind: "not-found" };
    }
    const syntaxHint = resolvePathShapeHintFromItems(pathStatement.items);
    if (syntaxHint !== shapeKind) {
        return { kind: "unsupported", reason: "Center-pivot rotate requires explicit circle/ellipse source syntax." };
    }
    const candidateHandles = editHandles.filter((handle) => handle.sourceRef.sourceId === elementId && handle.kind === "path-point");
    if (candidateHandles.length !== 1) {
        return { kind: "unsupported", reason: "Center-pivot rotate requires circle/ellipse paths with explicit center coordinates." };
    }
    const centerHandle = candidateHandles[0];
    if (!centerHandle || !isDirectFrameLocalHandle(centerHandle)) {
        return { kind: "unsupported", reason: "Center-pivot rotate requires a direct, rewritable center coordinate." };
    }
    return {
        kind: "found",
        shapeKind,
        center: center ?? centerHandle.world,
        centerHandle
    };
}
function buildRectangleCoordinateRewrites(source, context, pivot, deltaDeg, nextTransform) {
    const targetStart = rotateWorldPointAroundCenter(context.startHandle.world, pivot, deltaDeg);
    const targetOpposite = rotateWorldPointAroundCenter(context.oppositeHandle.world, pivot, deltaDeg);
    const startRewriteHandle = withFrameTransform(context.startHandle, nextTransform);
    const oppositeRewriteHandle = withFrameTransform(context.oppositeHandle, nextTransform);
    const replacements = [
        {
            handle: startRewriteHandle,
            newWorld: targetStart
        },
        {
            handle: oppositeRewriteHandle,
            newWorld: targetOpposite
        }
    ];
    return rewriteHandleTargets(source, replacements);
}
function buildEllipseLikeCoordinateRewrites(source, context, nextTransform) {
    return rewriteHandleTargets(source, [
        {
            handle: withFrameTransform(context.centerHandle, nextTransform),
            newWorld: context.center
        }
    ]);
}
function rewriteHandleTargets(source, targets) {
    const replacementBySpan = new Map();
    for (const target of targets) {
        const handle = target.handle;
        const actualText = source.slice(handle.sourceRef.sourceSpan.from, handle.sourceRef.sourceSpan.to);
        if (actualText !== handle.sourceText) {
            return { kind: "unsupported", reason: "Some selected handles are stale. Wait for recompute and try again." };
        }
        const text = rewriteCoordinate(target.newWorld, handle, source);
        if (text == null) {
            return { kind: "unsupported", reason: "Could not rewrite one or more coordinates for center-pivot rotate." };
        }
        if (text === actualText) {
            continue;
        }
        const spanKey = `${handle.sourceRef.sourceSpan.from}:${handle.sourceRef.sourceSpan.to}`;
        const existing = replacementBySpan.get(spanKey);
        if (existing) {
            if (existing.text !== text) {
                return { kind: "unsupported", reason: "Center-pivot rotate produced conflicting rewrites for a shared coordinate." };
            }
            continue;
        }
        replacementBySpan.set(spanKey, {
            span: handle.sourceRef.sourceSpan,
            text
        });
    }
    return { kind: "success", replacements: [...replacementBySpan.values()] };
}
function withFrameTransform(handle, transform) {
    if (!isDirectFrameLocalHandle(handle)) {
        return handle;
    }
    return {
        ...handle,
        frame: transform,
        transform: worldTransform(transform.a, transform.b, transform.c, transform.d, transform.e, transform.f)
    };
}
function resolveCenterPivot(context) {
    if (context.kind === "rectangle") {
        return worldPoint(pt((context.startHandle.world.x + context.oppositeHandle.world.x) / 2), pt((context.startHandle.world.y + context.oppositeHandle.world.y) / 2));
    }
    return context.center;
}
function pathHasUnsupportedTransformOptions(pathStatement) {
    const entries = pathStatement.options?.entries ?? [];
    for (const entry of entries) {
        if (entry.kind !== "kv") {
            continue;
        }
        const key = normalizeOptionKey(entry.key);
        if (key === "rotate" ||
            key === "/tikz/rotate" ||
            key === "rotate around" ||
            key === "/tikz/rotate around") {
            continue;
        }
        if (TRANSFORM_OPTION_KEYS.has(key)) {
            return true;
        }
    }
    return false;
}
const TRANSFORM_OPTION_KEYS = new Set([
    "shift",
    "/tikz/shift",
    "xshift",
    "/tikz/xshift",
    "yshift",
    "/tikz/yshift",
    "scale",
    "/tikz/scale",
    "xscale",
    "/tikz/xscale",
    "yscale",
    "/tikz/yscale",
    "cm",
    "/tikz/cm",
    "transform canvas",
    "/tikz/transform canvas"
]);
function resolveScenePathShapeHint(path, pathStatement) {
    return path.shapeHint ?? resolvePathShapeHintFromItems(pathStatement.items);
}
function resolvePathShapeHintFromItems(items) {
    const hints = new Set();
    collectPathShapeHints(items, hints);
    if (hints.size !== 1) {
        return null;
    }
    return [...hints][0] ?? null;
}
function collectPathShapeHints(items, hints) {
    for (const item of items) {
        if (item.kind === "PathKeyword") {
            if (item.keyword === "rectangle" || item.keyword === "circle" || item.keyword === "ellipse") {
                hints.add(item.keyword);
            }
            continue;
        }
        if (item.kind === "ChildOperation") {
            collectPathShapeHints(item.body, hints);
        }
    }
}
function isDirectFrameLocalHandle(handle) {
    return isFrameLocalCoordinateEditHandle(handle) && handle.rewriteMode === "direct";
}
function rotateAroundFrameTransform(angleDeg, pivot) {
    const radians = (angleDeg * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    return frameTransform(cos, sin, -sin, cos, pivot.x - cos * pivot.x + sin * pivot.y, pivot.y - sin * pivot.x - cos * pivot.y);
}
function rotateWorldPointAroundCenter(point, center, degrees) {
    const radians = (degrees * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const dx = point.x - center.x;
    const dy = point.y - center.y;
    return worldPoint(pt(center.x + dx * cos - dy * sin), pt(center.y + dx * sin + dy * cos));
}
function formatWorldPointCoordinateRaw(point) {
    return `(${formatNumber(point.x * CM_PER_PT)},${formatNumber(point.y * CM_PER_PT)})`;
}
function adjustReplacementsForPriorPatches(replacements, patches) {
    let adjusted = replacements;
    for (const patch of patches) {
        const delta = (patch.newSpan.to - patch.newSpan.from) - (patch.oldSpan.to - patch.oldSpan.from);
        if (delta === 0) {
            continue;
        }
        adjusted = adjusted.map((replacement) => ({
            ...replacement,
            span: replacement.span.from >= patch.oldSpan.to
                ? {
                    from: replacement.span.from + delta,
                    to: replacement.span.to + delta
                }
                : replacement.span
        }));
    }
    return adjusted;
}
function spansEqual(left, right) {
    return left.from === right.from && left.to === right.to;
}
function normalizeTinyNumber(value) {
    return Math.abs(value) <= 1e-9 ? 0 : value;
}
function normalizeSignedDeg(value) {
    let normalized = value % 360;
    if (normalized <= -180)
        normalized += 360;
    if (normalized > 180)
        normalized -= 360;
    return normalized;
}
function computeReplacementPatch(oldSource, newSource) {
    const oldLen = oldSource.length;
    const newLen = newSource.length;
    const minLen = Math.min(oldLen, newLen);
    let prefix = 0;
    while (prefix < minLen && oldSource.charCodeAt(prefix) === newSource.charCodeAt(prefix)) {
        prefix += 1;
    }
    let oldSuffix = oldLen;
    let newSuffix = newLen;
    while (oldSuffix > prefix &&
        newSuffix > prefix &&
        oldSource.charCodeAt(oldSuffix - 1) === newSource.charCodeAt(newSuffix - 1)) {
        oldSuffix -= 1;
        newSuffix -= 1;
    }
    return {
        oldSpan: { from: prefix, to: oldSuffix },
        newSpan: { from: prefix, to: newSuffix },
        replacement: newSource.slice(prefix, newSuffix)
    };
}
