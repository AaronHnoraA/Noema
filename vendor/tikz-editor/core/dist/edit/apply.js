import { replaceSpan } from "./patch.js";
import { formatCoordinate } from "./style.js";
import { rewriteCoordinate, supportsUnsupportedCoordinateDetach } from "./rewrite.js";
import { sourceFingerprintForEdit } from "./parse-options.js";
import { formatNumber } from "./format.js";
import { resolvePropertyTarget } from "./property-target.js";
import { applyOptionMutationsToTarget, normalizeOptionKey } from "./option-mutations.js";
export function applyEdit(parseResult, edit) {
    const target = findPathItem(parseResult.figure.body, edit.targetId);
    if (!target) {
        throw new Error(`Unknown edit target id: ${edit.targetId}`);
    }
    if (edit.kind === "updateCoordinate") {
        if (target.kind !== "Coordinate") {
            throw new Error(`Target ${edit.targetId} is not a coordinate.`);
        }
        const oldRaw = parseResult.source.slice(target.span.from, target.span.to);
        const replacement = formatCoordinate(oldRaw, edit.x, edit.y);
        const updated = replaceSpan(parseResult.source, target.span, replacement);
        return {
            source: updated.source,
            changedSpans: [updated.changedSpan]
        };
    }
    if (target.kind !== "Node") {
        throw new Error(`Target ${edit.targetId} is not a node.`);
    }
    const updated = replaceSpan(parseResult.source, target.textSpan, edit.text);
    return {
        source: updated.source,
        changedSpans: [updated.changedSpan]
    };
}
function findPathItem(statements, targetId) {
    for (const statement of statements) {
        if (statement.kind === "Path") {
            for (const item of statement.items) {
                if (item.id === targetId) {
                    return item;
                }
            }
        }
        if (statement.kind === "Scope") {
            const nested = findPathItem(statement.body, targetId);
            if (nested) {
                return nested;
            }
        }
    }
    return null;
}
export function applyEditIntent(source, editHandles, intent, parseOptions = {}) {
    if (intent.kind === "move") {
        return applyMoveIntent(source, editHandles, intent, parseOptions);
    }
    return { kind: "error", message: `Unknown intent kind: ${intent.kind}` };
}
function applyMoveIntent(source, editHandles, intent, parseOptions = {}) {
    const handle = editHandles.find((entry) => entry.id === intent.handleId);
    if (!handle) {
        return { kind: "error", message: `Handle not found: ${intent.handleId}` };
    }
    const sourceFingerprint = sourceFingerprintForEdit(source, parseOptions);
    if (handle.sourceRef.sourceFingerprint !== sourceFingerprint) {
        return { kind: "error", message: "Handle does not match current source (stale handle)." };
    }
    if (handle.curveEdit) {
        return applyCurveEditMoveIntent(source, handle, intent.newWorld, parseOptions);
    }
    const rewriteHandle = resolveRewriteHandle(handle, editHandles);
    if (!rewriteHandle) {
        return { kind: "error", message: "Rewrite target handle could not be resolved (stale handle?)." };
    }
    if (rewriteHandle.rewriteMode === "unsupported" && !supportsUnsupportedCoordinateDetach(rewriteHandle)) {
        return {
            kind: "unsupported",
            reason: `Coordinate form "${handle.coordinateForm}" cannot be rewritten`,
            handleId: handle.id
        };
    }
    if (editHandles.some((candidate) => candidate.id !== handle.id &&
        isConflictingRewriteTarget(candidate, rewriteHandle, editHandles))) {
        return {
            kind: "unsupported",
            reason: "Edit target maps to a shared source span (e.g. foreach/macro expansion).",
            handleId: handle.id
        };
    }
    if (rewriteHandle.sourceRef.sourceFingerprint !== sourceFingerprint) {
        return { kind: "error", message: "Handle does not match current source (stale handle)." };
    }
    if (rewriteHandle.sourceRef.sourceSpan.from < 0 ||
        rewriteHandle.sourceRef.sourceSpan.to > source.length ||
        rewriteHandle.sourceRef.sourceSpan.from > rewriteHandle.sourceRef.sourceSpan.to) {
        return { kind: "error", message: "Handle source span exceeds source length (stale handle?)" };
    }
    const currentSourceText = source.slice(rewriteHandle.sourceRef.sourceSpan.from, rewriteHandle.sourceRef.sourceSpan.to);
    if (currentSourceText !== rewriteHandle.sourceText) {
        return { kind: "error", message: "Handle span content mismatch (stale handle)." };
    }
    const replacement = rewriteCoordinate(intent.newWorld, rewriteHandle, source);
    if (replacement === null) {
        return {
            kind: "unsupported",
            reason: "Coordinate rewrite failed (non-invertible transform?)",
            handleId: handle.id
        };
    }
    const updated = replaceSpan(source, rewriteHandle.sourceRef.sourceSpan, replacement);
    return {
        kind: "success",
        newSource: updated.source,
        changedSourceIds: [handle.sourceRef.sourceId],
        patches: [
            {
                oldSpan: rewriteHandle.sourceRef.sourceSpan,
                newSpan: updated.changedSpan,
                replacement
            }
        ]
    };
}
function applyCurveEditMoveIntent(source, handle, newWorld, parseOptions = {}) {
    const curveEdit = handle.curveEdit;
    if (!curveEdit) {
        return { kind: "error", message: "Curve edit metadata is missing for this handle." };
    }
    const resolved = resolvePropertyTarget(source, curveEdit.operationItemId, parseOptions);
    if (resolved.kind !== "found") {
        return {
            kind: "unsupported",
            reason: resolved.reason,
            handleId: handle.id
        };
    }
    const mutations = buildCurveEditMutations(curveEdit, newWorld);
    if (mutations.size === 0) {
        return {
            kind: "unsupported",
            reason: "Curve edit would not change any option values.",
            handleId: handle.id
        };
    }
    const rewritten = applyOptionMutationsToTarget(source, resolved.target, mutations);
    if (!rewritten) {
        return {
            kind: "success",
            newSource: source,
            changedSourceIds: [handle.sourceRef.sourceId],
            patches: []
        };
    }
    return {
        kind: "success",
        newSource: rewritten.source,
        changedSourceIds: [handle.sourceRef.sourceId],
        patches: [rewritten.patch]
    };
}
function buildCurveEditMutations(curveEdit, newWorld) {
    if (curveEdit.kind === "to-angle") {
        const anchor = curveEdit.role === "out" ? curveEdit.startWorld : curveEdit.endWorld;
        const absolute = angleDegrees(anchor, newWorld);
        const optionValue = curveEdit.relative
            ? normalizeSignedDegrees(Math.round(absolute - curveEdit.baseHeading))
            : normalizeAbsoluteDegrees(Math.round(absolute));
        const mutations = new Map();
        mutations.set(normalizeOptionKey(curveEdit.role), {
            kind: "set",
            value: formatInteger(optionValue)
        });
        mutations.set(normalizeOptionKey("bend left"), { kind: "remove" });
        mutations.set(normalizeOptionKey("bend right"), { kind: "remove" });
        mutations.set(normalizeOptionKey("bend angle"), { kind: "remove" });
        return mutations;
    }
    const signedBendAngle = normalizeSignedDegrees(Math.round(signedBendAngleFromHandle(curveEdit.startWorld, curveEdit.endWorld, newWorld)));
    const bendDirectionKey = signedBendAngle >= 0 ? "bend left" : "bend right";
    const oppositeDirectionKey = signedBendAngle >= 0 ? "bend right" : "bend left";
    const mutations = new Map();
    mutations.set(normalizeOptionKey(bendDirectionKey), {
        kind: "set",
        value: formatInteger(Math.abs(signedBendAngle))
    });
    mutations.set(normalizeOptionKey(oppositeDirectionKey), { kind: "remove" });
    mutations.set(normalizeOptionKey("out"), { kind: "remove" });
    mutations.set(normalizeOptionKey("in"), { kind: "remove" });
    mutations.set(normalizeOptionKey("bend angle"), { kind: "remove" });
    return mutations;
}
function angleDegrees(from, to) {
    return (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
}
function formatInteger(value) {
    return formatNumber(Math.trunc(value));
}
function signedBendAngleFromHandle(start, end, handleWorld) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.hypot(dx, dy);
    if (!Number.isFinite(length) || length <= 1e-9) {
        return 0;
    }
    const midpoint = {
        x: (start.x + end.x) / 2,
        y: (start.y + end.y) / 2
    };
    const unitNormal = {
        x: -dy / length,
        y: dx / length
    };
    const signedOffset = (handleWorld.x - midpoint.x) * unitNormal.x +
        (handleWorld.y - midpoint.y) * unitNormal.y;
    const unsignedAngle = (Math.atan2(2 * Math.abs(signedOffset), length) * 180) / Math.PI;
    const signedAngle = signedOffset >= 0 ? unsignedAngle : -unsignedAngle;
    return normalizeSignedDegrees(signedAngle);
}
function normalizeAbsoluteDegrees(value) {
    if (!Number.isFinite(value)) {
        return 0;
    }
    const wrapped = ((value % 360) + 360) % 360;
    return Math.abs(wrapped) < 1e-9 ? 0 : wrapped;
}
function normalizeSignedDegrees(value) {
    if (!Number.isFinite(value)) {
        return 0;
    }
    const wrapped = ((value + 180) % 360 + 360) % 360 - 180;
    return Math.abs(wrapped) < 1e-9 ? 0 : wrapped;
}
function resolveRewriteHandle(handle, editHandles) {
    if (!handle.rewriteTargetHandleId) {
        return handle;
    }
    return editHandles.find((entry) => entry.id === handle.rewriteTargetHandleId) ?? null;
}
function isConflictingRewriteTarget(candidate, rewriteHandle, editHandles) {
    const candidateRewriteHandle = resolveRewriteHandle(candidate, editHandles);
    if (!candidateRewriteHandle) {
        return false;
    }
    if (candidateRewriteHandle.id === rewriteHandle.id) {
        return false;
    }
    return (candidateRewriteHandle.sourceRef.sourceSpan.from === rewriteHandle.sourceRef.sourceSpan.from &&
        candidateRewriteHandle.sourceRef.sourceSpan.to === rewriteHandle.sourceRef.sourceSpan.to);
}
export function isCoordinateItem(item) {
    return item.kind === "Coordinate";
}
export function isNodeItem(item) {
    return item.kind === "Node";
}
