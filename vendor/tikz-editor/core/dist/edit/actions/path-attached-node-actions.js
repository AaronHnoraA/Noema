import { applyOptionMutationsToTarget, normalizeOptionKey } from "../option-mutations.js";
import { resolvePropertyTarget } from "../property-target.js";
import { formatNumber, pointDistanceFormatOptions } from "../format.js";
import { PATH_ATTACHED_NODE_POSITION_VALUE_KEY, PATH_ATTACHED_NODE_SIDE_KEY } from "../path-attached-node-keys.js";
import { normalizePathPosition, resolvePathAttachedNodeRegime, resolvePathPositionPreset, resolveDraggedPathAttachedNodeDirection as resolveDraggedDirectionFromRegime } from "../../semantic/path/path-attached.js";
const PATH_ATTACHED_DISTANCE_EPSILON_PT = 0.05;
export const PATH_ATTACHED_NODE_EDIT_NOOP_REASON = "Path-attached node edit would not change the source.";
const POSITION_OPTION_KEYS = [
    "pos",
    "at start",
    "very near start",
    "near start",
    "midway",
    "near end",
    "very near end",
    "at end"
];
const CARDINAL_DIAGONAL_DIRECTIONS = [
    "above",
    "below",
    "left",
    "right",
    "above left",
    "above right",
    "below left",
    "below right"
];
const BASE_DIRECTIONS = ["base left", "base right"];
const MID_DIRECTIONS = ["mid left", "mid right"];
export function applyMovePathAttachedNodeAction(source, action, parseOptions = {}) {
    const resolved = resolvePropertyTarget(source, action.nodeId, parseOptions);
    if (resolved.kind !== "found" || resolved.target.kind !== "node-item") {
        return { kind: "unsupported", reason: "Selected path-attached node could not be resolved for drag editing." };
    }
    const regime = resolvePathAttachedNodeRegime(resolved.target.options);
    const mutations = new Map();
    applyPositionMutations(mutations, normalizePathPosition(action.pos));
    applySideMutations(mutations, regime, action.sideUpdate);
    applyDistanceMutations(mutations, regime, action);
    const rewritten = applyOptionMutationsToTarget(source, resolved.target, mutations);
    if (!rewritten) {
        return { kind: "unsupported", reason: PATH_ATTACHED_NODE_EDIT_NOOP_REASON };
    }
    return {
        kind: "success",
        newSource: rewritten.source,
        patches: [rewritten.patch],
        selectedSourceIds: [action.nodeId],
        changedSourceIds: [action.hostPathSourceId]
    };
}
export function applyPathAttachedNodeInspectorAction(source, action, parseOptions = {}) {
    if (action.key !== PATH_ATTACHED_NODE_POSITION_VALUE_KEY &&
        action.key !== PATH_ATTACHED_NODE_SIDE_KEY) {
        return null;
    }
    const resolved = resolvePropertyTarget(source, action.elementId, parseOptions);
    if (resolved.kind !== "found" || resolved.target.kind !== "node-item") {
        return { kind: "unsupported", reason: "Selected node could not be resolved for path-attached editing." };
    }
    const regime = resolvePathAttachedNodeRegime(resolved.target.options);
    const mutations = new Map();
    if (action.key === PATH_ATTACHED_NODE_POSITION_VALUE_KEY) {
        const parsed = Number(action.value);
        if (!Number.isFinite(parsed)) {
            return { kind: "error", message: "Path-attached node position must be a finite number." };
        }
        applyPositionMutations(mutations, parsed);
    }
    else if (action.key === PATH_ATTACHED_NODE_SIDE_KEY) {
        if (regime.kind === "neutral") {
            return { kind: "unsupported", reason: "Path-attached neutral placement does not support side editing." };
        }
        const sideValue = action.value.trim().toLowerCase();
        if (regime.kind === "auto-side") {
            if (sideValue !== "left" && sideValue !== "right") {
                return { kind: "error", message: "Path-attached auto side must be left or right." };
            }
            applySideMutations(mutations, regime, { kind: "auto-side", side: sideValue });
        }
        else {
            const normalizedDirection = normalizeOptionKey(sideValue);
            const allowedDirections = regime.family === "base" ? BASE_DIRECTIONS :
                regime.family === "mid" ? MID_DIRECTIONS :
                    CARDINAL_DIAGONAL_DIRECTIONS;
            const match = allowedDirections.find((candidate) => normalizeOptionKey(candidate) === normalizedDirection);
            if (!match) {
                return { kind: "error", message: "Path-attached explicit side is not compatible with the current regime." };
            }
            applySideMutations(mutations, regime, { kind: "explicit-direction", direction: match });
        }
    }
    const rewritten = applyOptionMutationsToTarget(source, resolved.target, mutations);
    if (!rewritten) {
        return { kind: "unsupported", reason: PATH_ATTACHED_NODE_EDIT_NOOP_REASON };
    }
    return {
        kind: "success",
        newSource: rewritten.source,
        patches: [rewritten.patch],
        selectedSourceIds: [action.elementId],
        changedSourceIds: [action.elementId]
    };
}
export function resolveDraggedPathAttachedNodeDirection(anchorWorldPoint, desiredCenter, regime) {
    return resolveDraggedDirectionFromRegime(anchorWorldPoint, desiredCenter, regime);
}
function applyPositionMutations(mutations, rawPosition) {
    const position = normalizePathPosition(rawPosition);
    const snapped = resolvePathPositionPreset(position, null);
    for (const key of POSITION_OPTION_KEYS) {
        mutations.set(key, { kind: "remove" });
    }
    if (snapped.preset === "midway") {
        return;
    }
    if (snapped.preset) {
        mutations.set(snapped.preset, { kind: "set", value: "" });
        return;
    }
    mutations.set("pos", { kind: "set", value: formatNumber(position) });
}
function applySideMutations(mutations, regime, sideUpdate) {
    if (!sideUpdate) {
        return;
    }
    if (regime.kind === "explicit-direction" && sideUpdate.kind === "explicit-direction") {
        const clearKeys = regime.family === "base" ? BASE_DIRECTIONS :
            regime.family === "mid" ? MID_DIRECTIONS :
                CARDINAL_DIAGONAL_DIRECTIONS;
        for (const key of clearKeys) {
            mutations.set(key, { kind: "remove" });
        }
        mutations.set(sideUpdate.direction, { kind: "set", value: "" });
        return;
    }
    if (regime.kind === "auto-side" && sideUpdate.kind === "auto-side") {
        const baseSide = regime.swap ? (regime.side === "left" ? "right" : "left") : regime.side;
        const desiredSwap = sideUpdate.side !== baseSide;
        mutations.set("auto", { kind: "set", value: baseSide === "left" ? "" : baseSide });
        if (desiredSwap) {
            mutations.set("swap", { kind: "set", value: "" });
        }
        else {
            mutations.set("swap", { kind: "remove" });
        }
    }
}
function applyDistanceMutations(mutations, regime, action) {
    if (regime.kind !== "explicit-direction") {
        return;
    }
    if (!Number.isFinite(action.distanceUpdatePt)) {
        return;
    }
    const resolvedDistance = Math.max(0, action.distanceUpdatePt);
    const resolvedDirection = action.sideUpdate?.kind === "explicit-direction"
        ? action.sideUpdate.direction
        : regime.direction;
    if (resolvedDistance <= PATH_ATTACHED_DISTANCE_EPSILON_PT) {
        mutations.set(resolvedDirection, { kind: "set", value: "" });
        return;
    }
    mutations.set(resolvedDirection, {
        kind: "set",
        value: `${formatNumber(resolvedDistance, pointDistanceFormatOptions(action.formatPrecision))}pt`
    });
}
